#[cfg(target_os = "macos")]
mod capture;
#[cfg(not(target_os = "macos"))]
mod capture {
    pub struct CaptureState(());
    impl Default for CaptureState {
        fn default() -> Self {
            CaptureState(())
        }
    }
    #[tauri::command]
    pub fn list_displays() -> Vec<serde_json::Value> {
        vec![]
    }
    #[tauri::command]
    pub fn list_sources() -> serde_json::Value {
        serde_json::json!({ "displays": [], "windows": [] })
    }
    #[tauri::command]
    pub fn start_native_capture() -> Result<(), String> {
        Err("Native screen capture is only available on macOS (this is a browser/Tauri preview build).".into())
    }
    #[tauri::command]
    pub fn stop_native_capture() -> Result<(), String> {
        Err("No capture running".into())
    }
    #[tauri::command]
    pub fn read_recording(_path: String) -> Result<tauri::ipc::Response, String> {
        Err("Native screen capture is only available on macOS.".into())
    }
}

/// Open a finished export in the OS's default app (video/GIF/PNG player).
mod open {
    #[tauri::command]
    pub fn open_path(path: String) -> Result<(), String> {
        let mut cmd = if cfg!(target_os = "macos") {
            let mut c = std::process::Command::new("open");
            c.arg(&path);
            c
        } else if cfg!(target_os = "windows") {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "start", ""]).arg(&path);
            c
        } else {
            let mut c = std::process::Command::new("xdg-open");
            c.arg(&path);
            c
        };
        let status = cmd
            .status()
            .map_err(|e| format!("Could not open {path}: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Could not open {path}: exited with {status}"))
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(capture::CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            capture::list_displays,
            capture::list_sources,
            capture::start_native_capture,
            capture::stop_native_capture,
            capture::read_recording,
            open::open_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Glimpse");
}
