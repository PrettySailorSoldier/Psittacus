mod recording;
mod tesseract_ocr;

use recording::RecordingState;
use tauri::{Manager, RunEvent};

/// Excludes the app's own window from screen capture (gdigrab included, since
/// Windows 10 2004+ applies this affinity to legacy BitBlt-based capture too),
/// so Psittacus never shows up in its own desktop recordings — whatever is
/// behind the window is what gets captured instead.
#[cfg(target_os = "windows")]
fn exclude_from_capture(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};

    let Ok(hwnd) = window.hwnd() else { return };
    let _ = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) };
}

#[cfg(not(target_os = "windows"))]
fn exclude_from_capture(_window: &tauri::WebviewWindow) {}

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
            tesseract_ocr::tesseract_ocr_image,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                exclude_from_capture(&window);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // Don't leave ffmpeg grabbing the screen if the window closes mid-recording.
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            recording::stop_on_exit(&handle.state::<RecordingState>());
        }
    });
}
