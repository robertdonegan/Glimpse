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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Glimpse");
}
