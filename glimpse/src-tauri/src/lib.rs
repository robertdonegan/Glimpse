mod capture;

pub fn run() {
    tauri::Builder::default()
        .manage(capture::CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            capture::start_native_capture,
            capture::stop_native_capture,
            capture::read_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Glimpse");
}
