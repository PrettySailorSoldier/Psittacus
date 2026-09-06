//! Native screen recording.
//!
//! Spawns the bundled ffmpeg sidecar as a screen grabber (gdigrab on Windows,
//! x11grab on Linux) and writes an mp4 into the app cache dir. The resulting
//! file is handed back to the frontend, which feeds it into the same frame
//! extraction + OCR pipeline used by the "Import Video" flow.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

/// How long we wait for ffmpeg to finalize the mp4 after being asked to quit.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a freshly spawned ffmpeg is given to reject its own arguments.
/// Long enough to catch an input it refuses to open, short enough that it is
/// not felt as lag on the Record button.
const STARTUP_GRACE: Duration = Duration::from_millis(600);
/// Capture rate. The pipeline samples at most 1fps, so this is plenty and it
/// keeps the CPU cost of the capture itself low.
const CAPTURE_FRAMERATE: &str = "15";
/// Number of trailing ffmpeg log lines kept for error reporting.
const LOG_TAIL: usize = 40;

struct ActiveRecording {
    child: CommandChild,
    output_path: PathBuf,
    /// Resolves once ffmpeg has actually exited (and therefore flushed the
    /// moov atom). Waiting on this is what keeps the mp4 from being corrupt.
    exited: oneshot::Receiver<Option<i32>>,
    log: Arc<Mutex<Vec<String>>>,
}

#[derive(Default)]
pub struct RecordingState {
    inner: Mutex<Option<ActiveRecording>>,
}

/// Bounds of the monitor showing the app, as gdigrab wants them:
/// `(offset_x, offset_y, width, height)`.
///
/// gdigrab's `desktop` input grabs the *virtual* desktop — every monitor
/// stitched into one bitmap — so on a multi-monitor machine a plain desktop
/// capture drags in whatever happens to be on the other screens. Restricting
/// the grab to one monitor is what keeps a second display's icons, taskbar and
/// unrelated windows out of the recording in the first place, rather than
/// leaving it to the crop step to cut them back out.
#[cfg(target_os = "windows")]
fn monitor_capture_region(app: &AppHandle) -> Option<(i32, i32, u32, u32)> {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    let hwnd = app.get_webview_window("main")?.hwnd().ok()?;

    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };

    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return None;
    }

    let rect = info.rcMonitor;
    let width = u32::try_from(rect.right - rect.left).ok()?;
    let height = u32::try_from(rect.bottom - rect.top).ok()?;
    if width == 0 || height == 0 {
        return None;
    }

    // gdigrab checks offset_x/offset_y against the virtual desktop in absolute
    // coordinates, which run negative for a monitor above or left of the
    // primary. `rcMonitor` is already in exactly that space, so it is passed
    // through as-is — normalising it to a (0, 0) origin puts the capture area
    // outside the desktop bounds and ffmpeg refuses to open the input.
    Some((rect.left, rect.top, width, height))
}

/// Returns the ffmpeg input format, input spec, and any args that must precede
/// `-i` (the region flags) for this platform.
#[cfg(target_os = "windows")]
fn capture_input(
    app: &AppHandle,
    window_target: Option<String>,
) -> Result<(&'static str, String, Vec<String>), String> {
    if let Some(title) = window_target
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        // gdigrab crops to the window itself, so no region flags are needed.
        return Ok(("gdigrab", format!("title={title}"), Vec::new()));
    }

    // Falls back to the whole virtual desktop if the monitor geometry can't be
    // read — an over-wide recording beats no recording at all.
    let region = match monitor_capture_region(app) {
        Some((x, y, w, h)) => vec![
            "-offset_x".to_string(),
            x.to_string(),
            "-offset_y".to_string(),
            y.to_string(),
            "-video_size".to_string(),
            format!("{w}x{h}"),
        ],
        None => Vec::new(),
    };

    Ok(("gdigrab", "desktop".to_string(), region))
}

#[cfg(target_os = "linux")]
fn capture_input(
    _app: &AppHandle,
    window_target: Option<String>,
) -> Result<(&'static str, String, Vec<String>), String> {
    // x11grab addresses displays/regions rather than window titles, so
    // window_target is treated as a raw display spec (e.g. ":0.0+100,200").
    let input = match window_target.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => std::env::var("DISPLAY").unwrap_or_else(|_| ":0.0".to_string()),
    };
    Ok(("x11grab", input, Vec::new()))
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn capture_input(
    _app: &AppHandle,
    _window_target: Option<String>,
) -> Result<(&'static str, String, Vec<String>), String> {
    Err("Screen recording is only supported on Windows and Linux.".to_string())
}

fn timestamped_output(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Could not resolve the app cache directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("System clock error: {e}"))?
        .as_millis();

    Ok(dir.join(format!("psittacus_recording_{stamp}.mp4")))
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, RecordingState>,
    window_target: Option<String>,
) -> Result<(), String> {
    if state.inner.lock().unwrap().is_some() {
        return Err("A recording is already in progress.".to_string());
    }

    let (format, input, region) = capture_input(&app, window_target)?;
    let output_path = timestamped_output(&app)?;
    let output_arg = output_path.to_string_lossy().to_string();

    // Built as owned strings because the region flags are computed at runtime.
    let mut args = vec!["-f".to_string(), format.to_string()];
    // The region flags are input options, so they have to land before `-i`.
    args.extend(region);
    args.extend([
        "-framerate".to_string(),
        CAPTURE_FRAMERATE.to_string(),
        "-i".to_string(),
        input,
        // gdigrab/x11grab can hand back odd dimensions, which yuv420p rejects.
        "-vf".to_string(),
        "scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "ultrafast".to_string(),
        // Fairly high quality: these frames are going to an OCR model, and
        // compression artifacts on small text cost accuracy.
        "-crf".to_string(),
        "18".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-y".to_string(),
        output_arg,
    ]);

    let command = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Could not locate the ffmpeg sidecar: {e}"))?
        .args(args);

    let (mut events, child) = command
        .spawn()
        .map_err(|e| format!("Could not start ffmpeg: {e}"))?;

    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let (exit_tx, exit_rx) = oneshot::channel();

    // The event channel must be drained continuously: if it fills, the
    // plugin's reader thread blocks, ffmpeg's stderr pipe backs up, and the
    // capture stalls. This task also tells us when ffmpeg has truly exited.
    let log_writer = Arc::clone(&log);
    tauri::async_runtime::spawn(async move {
        let mut exit_tx = Some(exit_tx);
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(bytes) | CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    let mut buf = log_writer.lock().unwrap();
                    buf.push(line);
                    if buf.len() > LOG_TAIL {
                        let overflow = buf.len() - LOG_TAIL;
                        buf.drain(0..overflow);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Some(tx) = exit_tx.take() {
                        let _ = tx.send(payload.code);
                    }
                    break;
                }
                _ => {}
            }
        }
        // Channel closed without an explicit Terminated event.
        if let Some(tx) = exit_tx.take() {
            let _ = tx.send(None);
        }
    });

    // ffmpeg validates its input options only after it has been spawned, so a
    // rejected capture region looks like a *successful* start followed by an
    // immediate exit. Without this pause the UI would sit on a running timer
    // recording nothing, and the failure would not surface until Stop — with
    // the whole session already lost. Better to fail here, while the user can
    // still act on it.
    tokio::time::sleep(STARTUP_GRACE).await;

    let mut exit_rx = exit_rx;
    if let Ok(code) = exit_rx.try_recv() {
        let tail = log.lock().unwrap().join("\n");
        return Err(match code {
            Some(c) => format!("ffmpeg exited immediately with code {c}.\n{tail}"),
            None => format!("ffmpeg exited immediately.\n{tail}"),
        });
    }

    *state.inner.lock().unwrap() = Some(ActiveRecording {
        child,
        output_path,
        exited: exit_rx,
        log,
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_recording(state: State<'_, RecordingState>) -> Result<String, String> {
    // Take the recording out of state before awaiting, so the lock guard is
    // never held across an await point.
    let recording = state
        .inner
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "No recording is in progress.".to_string())?;

    let ActiveRecording {
        mut child,
        output_path,
        exited,
        log,
    } = recording;

    let tail = move || log.lock().unwrap().join("\n");

    // ffmpeg finalizes the mp4 (writes the moov atom) only on a clean exit.
    // Killing it here would leave an unplayable file, so ask it to quit the
    // way it expects: a 'q' on stdin.
    if let Err(e) = child.write(b"q") {
        // A broken pipe here almost always means ffmpeg already died on its
        // own (a bad window title, a lost display). Its own log says why, and
        // that is far more useful to surface than the write error.
        return Err(format!(
            "ffmpeg stopped before the recording could be ended ({e}).\n{}",
            tail()
        ));
    }

    match tokio::time::timeout(STOP_TIMEOUT, exited).await {
        Ok(Ok(Some(0))) | Ok(Ok(None)) => {}
        Ok(Ok(Some(code))) => {
            return Err(format!(
                "ffmpeg exited with code {code} while finishing the recording.\n{}",
                tail()
            ));
        }
        Ok(Err(_)) => {
            // Watcher task dropped the sender; ffmpeg is gone either way.
        }
        Err(_) => {
            return Err(format!(
                "ffmpeg did not shut down within {}s, so the recording at {} may be incomplete.\n{}",
                STOP_TIMEOUT.as_secs(),
                output_path.display(),
                tail()
            ));
        }
    }

    if !output_path.exists() {
        return Err(format!("ffmpeg produced no output file.\n{}", tail()));
    }

    Ok(output_path.to_string_lossy().to_string())
}

/// Ends an in-flight recording when the app is shutting down.
///
/// Without this, closing the window mid-recording leaves ffmpeg capturing the
/// screen as an orphan process, and the mp4 it was writing never gets its moov
/// atom. Not a Tauri command — called from the app's exit handler.
pub fn stop_on_exit(state: &RecordingState) {
    let Some(recording) = state.inner.lock().unwrap().take() else {
        return;
    };

    let ActiveRecording {
        mut child, exited, ..
    } = recording;

    if child.write(b"q").is_err() {
        let _ = child.kill();
        return;
    }

    // Give ffmpeg a bounded window to finalize the file. Writing the index is
    // quick even for long recordings, so this rarely costs the user anything.
    let finalized = tauri::async_runtime::block_on(async {
        tokio::time::timeout(STOP_TIMEOUT, exited).await.is_ok()
    });

    if !finalized {
        let _ = child.kill();
    }
}

/// Deletes a finished recording. Called by the frontend once the recording has
/// been through extraction, so cache files don't pile up.
#[tauri::command]
pub async fn discard_recording(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);

    // Only ever delete inside our own cache dir.
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Could not resolve the app cache directory: {e}"))?;
    if !target.starts_with(&cache_dir) {
        return Err(format!(
            "Refusing to delete a file outside the app cache: {path}"
        ));
    }

    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete {path}: {e}")),
    }
}
