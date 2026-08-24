mod recording;

use recording::RecordingState;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(RecordingState::default())
        .invoke_handler(tauri::generate_handler![
            recording::start_recording,
            recording::stop_recording,
            recording::discard_recording,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // Don't leave ffmpeg grabbing the screen if the window closes mid-recording.
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            recording::stop_on_exit(&handle.state::<RecordingState>());
        }
    });
}
