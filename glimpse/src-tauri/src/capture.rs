//! Native screen capture for Glimpse.
//!
//! Pixels: macOS's built-in `screencapture -v` records the display to a .mov
//! and — crucially — does NOT draw the cursor into the pixels. That gives the
//! editor a cursor-free canvas for any app on screen, not just a browser tab.
//!
//! Telemetry: a polling thread samples the global mouse position and button
//! state through CoreGraphics at 240 Hz. Polling (rather than an event tap)
//! needs NO Input Monitoring permission and cannot trip the TCC-related
//! crashes that plague event taps started off the main thread.
//!
//! Permissions (macOS): only Screen Recording (for screencapture), prompted
//! on first use.

use serde::Serialize;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone)]
pub struct Sample {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    /// Pointer was over an interactive UI element (hand-cursor territory).
    pub hand: bool,
}

#[derive(Serialize, Clone)]
pub struct Click {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub button: i32,
}

#[derive(Serialize)]
pub struct CaptureResult {
    pub path: String,
    pub duration_ms: f64,
    pub cursor: Vec<Sample>,
    pub clicks: Vec<Click>,
    pub screen_w: f64,
    pub screen_h: f64,
    pub has_audio: bool,
}

/* ---------- CoreGraphics FFI (query-only, permission-free) ---------- */

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
    /// state_id 0 = combined session state; button 0 = left, 1 = right, 2 = center.
    fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayPixelsWide(display: u32) -> usize;
    fn CGDisplayPixelsHigh(display: u32) -> usize;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}

/// Global mouse position in points, origin top-left of the main display.
fn mouse_location() -> Option<(f64, f64)> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let p = CGEventGetLocation(event);
        CFRelease(event);
        Some((p.x, p.y))
    }
}

fn button_state(cg_button: u32) -> bool {
    unsafe { CGEventSourceButtonState(0, cg_button) }
}

fn main_display_size() -> (f64, f64) {
    unsafe {
        let id = CGMainDisplayID();
        (
            CGDisplayPixelsWide(id) as f64,
            CGDisplayPixelsHigh(id) as f64,
        )
    }
}

/* ---------- Accessibility: hover-hand detection ----------
 *
 * "Is the pointer over something clickable?" has no global cursor-type API,
 * but the Accessibility tree knows the role of the element under any screen
 * point. Needs the Accessibility permission (prompted on first capture);
 * without it hand detection is silently off and everything else still works.
 */

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    fn AXUIElementCreateSystemWide() -> *const std::ffi::c_void;
    fn AXUIElementCopyElementAtPosition(
        el: *const std::ffi::c_void,
        x: f32,
        y: f32,
        out: *mut *const std::ffi::c_void,
    ) -> i32;
    fn AXUIElementCopyAttributeValue(
        el: *const std::ffi::c_void,
        attr: *const std::ffi::c_void,
        out: *mut *const std::ffi::c_void,
    ) -> i32;
    static kAXTrustedCheckOptionPrompt: *const std::ffi::c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(
        alloc: *const std::ffi::c_void,
        s: *const std::ffi::c_char,
        encoding: u32,
    ) -> *const std::ffi::c_void;
    fn CFStringGetCString(
        s: *const std::ffi::c_void,
        buf: *mut std::ffi::c_char,
        size: isize,
        encoding: u32,
    ) -> bool;
    fn CFGetTypeID(cf: *const std::ffi::c_void) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFDictionaryCreate(
        alloc: *const std::ffi::c_void,
        keys: *const *const std::ffi::c_void,
        values: *const *const std::ffi::c_void,
        count: isize,
        key_callbacks: *const std::ffi::c_void,
        value_callbacks: *const std::ffi::c_void,
    ) -> *const std::ffi::c_void;
    static kCFTypeDictionaryKeyCallBacks: std::ffi::c_void;
    static kCFTypeDictionaryValueCallBacks: std::ffi::c_void;
    static kCFBooleanTrue: *const std::ffi::c_void;
}

const CF_UTF8: u32 = 0x0800_0100;

/// Check (and prompt once for) the Accessibility permission.
fn ax_trusted_with_prompt() -> bool {
    unsafe {
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let dict = CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks as *const _,
            &kCFTypeDictionaryValueCallBacks as *const _,
        );
        let trusted = AXIsProcessTrustedWithOptions(dict);
        if !dict.is_null() {
            CFRelease(dict);
        }
        trusted
    }
}

/// Roles that read as "clickable" — where a web page would show a hand.
const HAND_ROLES: [&str; 9] = [
    "AXLink",
    "AXButton",
    "AXPopUpButton",
    "AXMenuButton",
    "AXMenuItem",
    "AXCheckBox",
    "AXRadioButton",
    "AXComboBox",
    "AXDisclosureTriangle",
];

struct AxProbe {
    system_wide: *const std::ffi::c_void,
    role_attr: *const std::ffi::c_void,
}

// Raw CF pointers are thread-affine-free for this read-only use.
unsafe impl Send for AxProbe {}

impl AxProbe {
    fn new() -> Self {
        unsafe {
            AxProbe {
                system_wide: AXUIElementCreateSystemWide(),
                role_attr: CFStringCreateWithCString(
                    std::ptr::null(),
                    c"AXRole".as_ptr(),
                    CF_UTF8,
                ),
            }
        }
    }

    fn is_interactive_at(&self, x: f64, y: f64) -> bool {
        unsafe {
            let mut el: *const std::ffi::c_void = std::ptr::null();
            if AXUIElementCopyElementAtPosition(self.system_wide, x as f32, y as f32, &mut el)
                != 0
                || el.is_null()
            {
                return false;
            }
            let mut val: *const std::ffi::c_void = std::ptr::null();
            let got = AXUIElementCopyAttributeValue(el, self.role_attr, &mut val) == 0
                && !val.is_null();
            CFRelease(el);
            if !got {
                return false;
            }
            let mut hand = false;
            if CFGetTypeID(val) == CFStringGetTypeID() {
                let mut buf = [0i8; 64];
                if CFStringGetCString(val, buf.as_mut_ptr(), buf.len() as isize, CF_UTF8) {
                    let role = std::ffi::CStr::from_ptr(buf.as_ptr())
                        .to_string_lossy()
                        .into_owned();
                    hand = HAND_ROLES.contains(&role.as_str());
                }
            }
            CFRelease(val);
            hand
        }
    }
}

impl Drop for AxProbe {
    fn drop(&mut self) {
        unsafe {
            if !self.system_wide.is_null() {
                CFRelease(self.system_wide);
            }
            if !self.role_attr.is_null() {
                CFRelease(self.role_attr);
            }
        }
    }
}

/* ---------- Telemetry poller ---------- */

#[derive(Default)]
struct TelemetryLog {
    cursor: Vec<Sample>,
    clicks: Vec<Click>,
}

/// (CG button id, JS MouseEvent.button value)
const BUTTONS: [(u32, i32); 3] = [(0, 0), (1, 2), (2, 1)];

fn spawn_poller(
    stop: Arc<AtomicBool>,
    log: Arc<Mutex<TelemetryLog>>,
    t0: Instant,
    ax_enabled: bool,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let probe = if ax_enabled { Some(AxProbe::new()) } else { None };
        let mut last_pos = (f64::NAN, f64::NAN);
        let mut was_down = [false; 3];
        let mut hand = false;
        let mut tick: u32 = 0;
        while !stop.load(Ordering::Relaxed) {
            let t = t0.elapsed().as_secs_f64() * 1000.0;
            if let Some((x, y)) = mouse_location() {
                // The AX walk is the expensive part — refresh at ~30 Hz, not 240.
                if let Some(p) = &probe {
                    if tick % 8 == 0 {
                        hand = p.is_interactive_at(x, y);
                    }
                }
                let mut l = match log.lock() {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if (x, y) != last_pos {
                    last_pos = (x, y);
                    l.cursor.push(Sample { t, x, y, hand });
                }
                for (i, (cg, js)) in BUTTONS.iter().enumerate() {
                    let down = button_state(*cg);
                    if down && !was_down[i] {
                        l.clicks.push(Click {
                            t,
                            x,
                            y,
                            button: *js,
                        });
                    }
                    was_down[i] = down;
                }
            }
            tick = tick.wrapping_add(1);
            // ~240 Hz — matches the browser tracker's sample budget.
            std::thread::sleep(Duration::from_micros(4166));
        }
    })
}

/* ---------- Capture lifecycle ---------- */

struct ActiveCapture {
    child: Child,
    start: Instant,
    /// Wall-clock ms when telemetry began — compared against the sidecar's
    /// FIRST_FRAME_MS to align cursor data with the video.
    start_unix_ms: u64,
    first_frame_ms: Arc<Mutex<Option<u64>>>,
    path: String,
    has_audio: bool,
    stop_flag: Arc<AtomicBool>,
    log: Arc<Mutex<TelemetryLog>>,
    poller: JoinHandle<()>,
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The ScreenCaptureKit sidecar next to our executable, if it was built.
fn sidecar_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join("glimpse-capture");
    p.exists().then_some(p)
}

pub struct CaptureState(Mutex<Option<ActiveCapture>>);

impl Default for CaptureState {
    fn default() -> Self {
        CaptureState(Mutex::new(None))
    }
}

#[tauri::command]
pub fn start_native_capture(
    state: tauri::State<CaptureState>,
    audio: bool,
) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Err("A capture is already running".into());
    }

    let path = std::env::temp_dir()
        .join(format!(
            "glimpse-native-{}.mov",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ))
        .to_string_lossy()
        .into_owned();

    let start = Instant::now();
    let start_unix_ms = unix_ms();
    let first_frame_ms: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));

    // Preferred: our ScreenCaptureKit sidecar — records with showsCursor=false
    // (truly cursor-free pixels) and reports its first-frame wall clock so
    // telemetry aligns with the video. Fallback: `screencapture` (bakes the
    // cursor, no sync marker).
    let child = if let Some(sidecar) = sidecar_path() {
        let mut cmd = Command::new(sidecar);
        cmd.arg(&path)
            .arg(if audio { "1" } else { "0" })
            .stdout(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| {
            format!("Could not start capture sidecar: {e}. Grant Screen Recording permission and retry.")
        })?;
        if let Some(stdout) = child.stdout.take() {
            let ff = first_frame_ms.clone();
            std::thread::spawn(move || {
                use std::io::{BufRead, BufReader};
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(v) = line.strip_prefix("FIRST_FRAME_MS ") {
                        if let Ok(ms) = v.trim().parse::<u64>() {
                            if let Ok(mut g) = ff.lock() {
                                *g = Some(ms);
                            }
                        }
                    }
                }
            });
        }
        child
    } else {
        // -v video, -x no UI sounds, -g include default audio input.
        let mut cmd = Command::new("screencapture");
        cmd.arg("-v").arg("-x");
        if audio {
            cmd.arg("-g");
        }
        cmd.arg(&path);
        cmd.spawn().map_err(|e| {
            format!(
                "Could not start screencapture: {e}. Grant Screen Recording permission and retry."
            )
        })?
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    let log = Arc::new(Mutex::new(TelemetryLog::default()));
    // Prompts for Accessibility on first use; hand detection degrades
    // gracefully to "always arrow" if declined.
    let ax_enabled = ax_trusted_with_prompt();
    let poller = spawn_poller(stop_flag.clone(), log.clone(), start, ax_enabled);

    *slot = Some(ActiveCapture {
        child,
        start,
        start_unix_ms,
        first_frame_ms,
        path,
        has_audio: audio,
        stop_flag,
        log,
        poller,
    });
    Ok(())
}

#[tauri::command]
pub fn stop_native_capture(state: tauri::State<CaptureState>) -> Result<CaptureResult, String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    let mut active = slot.take().ok_or("No capture running")?;

    active.stop_flag.store(true, Ordering::Relaxed);
    let _ = active.poller.join();
    let telemetry = active
        .log
        .lock()
        .map(|mut l| TelemetryLog {
            cursor: std::mem::take(&mut l.cursor),
            clicks: std::mem::take(&mut l.clicks),
        })
        .unwrap_or_default();

    // SIGINT lets screencapture finalise the .mov cleanly (like ctrl-c).
    unsafe {
        libc::kill(active.child.id() as i32, libc::SIGINT);
    }
    let _ = active.child.wait();

    // Align telemetry to the video: the sidecar reports when its first frame
    // actually landed; everything before that instant is pre-roll.
    let shift_ms = active
        .first_frame_ms
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|ff| ff.saturating_sub(active.start_unix_ms) as f64)
        .unwrap_or(0.0);
    let cursor: Vec<Sample> = telemetry
        .cursor
        .into_iter()
        .map(|mut s| {
            s.t = (s.t - shift_ms).max(0.0);
            s
        })
        .collect();
    let clicks: Vec<Click> = telemetry
        .clicks
        .into_iter()
        .map(|mut c| {
            c.t = (c.t - shift_ms).max(0.0);
            c
        })
        .collect();

    let duration_ms = (active.start.elapsed().as_secs_f64() * 1000.0 - shift_ms).max(1.0);
    let (screen_w, screen_h) = main_display_size();

    if !std::path::Path::new(&active.path).exists() {
        return Err(
            "Recording file was not written. Grant Screen Recording permission in \
             System Settings → Privacy & Security → Screen Recording, then restart Glimpse."
                .into(),
        );
    }

    Ok(CaptureResult {
        path: active.path,
        duration_ms,
        cursor,
        clicks,
        screen_w,
        screen_h,
        has_audio: active.has_audio,
    })
}

/// Stream the finished recording to the webview as raw bytes, then delete it.
/// Path is restricted to the files this module creates.
#[tauri::command]
pub fn read_recording(path: String) -> Result<tauri::ipc::Response, String> {
    let tmp = std::env::temp_dir();
    let p = std::path::Path::new(&path);
    let valid = p.starts_with(&tmp)
        && p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("glimpse-native-") && n.ends_with(".mov"))
            .unwrap_or(false);
    if !valid {
        return Err("Invalid recording path".into());
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(p);
    Ok(tauri::ipc::Response::new(bytes))
}
