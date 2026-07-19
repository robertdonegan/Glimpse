mod capture;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(capture::CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            capture::list_displays,
            capture::start_native_capture,
            capture::stop_native_capture,
            capture::read_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Glimpse");
}
