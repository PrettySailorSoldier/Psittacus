//! Tesseract OCR via `std::process::Command`.
//!
//! Spawns Tesseract and parses the TSV output it writes to stdout into a plain
//! text string plus a mean confidence score.
//!
//! Psittacus ships its own Tesseract — the executable, the ~55 DLLs it is
//! dynamically linked against, and a tessdata directory — as a bundled
//! resource, so OCR works on a machine with nothing installed. A system install
//! is still used as a fallback if the bundled copy is ever missing.
//!
//! WHY NOT `externalBin`/sidecar: the Tesseract build is dynamically linked and
//! its DLLs must sit in the same directory as the exe, but `externalBin` stages
//! a single file. Shipping the whole directory as a resource and launching it by
//! ABSOLUTE path is what makes it load: the Windows loader uses the exe's own
//! directory as DLL search location #1 only when the process is started that
//! way. A PATH-shim lookup skips that step and produces
//! `STATUS_DLL_NOT_FOUND (0xC0000135)` — which is exactly what the bare
//! executable does on its own, with no DLLs beside it.

use tauri::Manager;

/// Windows: run the child without allocating a console.
///
/// Release builds set `windows_subsystem = "windows"`, so the app has no console
/// of its own and each `Command` spawn would otherwise pop a console window —
/// once per frame, i.e. hundreds of times in a single run. Debug builds keep a
/// console, which is why this stays invisible under `tauri dev`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Result returned to the frontend for each OCR'd frame.
#[derive(serde::Serialize)]
pub struct TesseractResult {
    /// The extracted text, with newlines reconstructed from line/block breaks.
    pub text: String,
    /// Mean per-word confidence reported by Tesseract, in the range 0–100.
    /// 0.0 means no words were recognised (blank or image-only frame).
    pub confidence: f32,
}

/// A usable Tesseract: the executable, plus the tessdata directory to pass
/// explicitly when it is the bundled copy (a system install finds its own).
struct TesseractInstall {
    exe: std::path::PathBuf,
    tessdata: Option<std::path::PathBuf>,
}

/// Run Tesseract on a single image file and return the extracted text with
/// its mean confidence score.
///
/// Calls `tesseract <path> stdout [--tessdata-dir <dir>] tsv` on a blocking
/// thread (OCR is CPU-bound and `std::process::Command::output()` is
/// synchronous).
#[tauri::command]
pub async fn tesseract_ocr_image(
    app: tauri::AppHandle,
    path: String,
) -> Result<TesseractResult, String> {
    let install = resolve_tesseract(&app);

    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&install.exe);
        cmd.arg(&path).arg("stdout");
        // Must precede the `tsv` config file argument.
        if let Some(dir) = &install.tessdata {
            cmd.arg("--tessdata-dir").arg(dir);
        }
        cmd.arg("tsv");

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.output()
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
    .map_err(|e| format!("Failed to run tesseract: {e}"))?;

    // Tesseract writes informational messages to stderr even on success; treat
    // only a non-zero exit code as a hard error.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Tesseract exited with code {:?}: {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    let tsv = String::from_utf8_lossy(&output.stdout);
    parse_tsv(&tsv)
}

/// Locate Tesseract, preferring the copy shipped with the app.
fn resolve_tesseract(app: &tauri::AppHandle) -> TesseractInstall {
    bundled_tesseract(app).unwrap_or_else(|| TesseractInstall {
        exe: resolve_system_tesseract_exe(),
        // A system install reads its own tessdata; overriding it with ours
        // would only risk a traineddata/engine version mismatch.
        tessdata: None,
    })
}

/// Strip Windows' `\\?\` verbatim prefix from a path.
///
/// `resource_dir()` hands back a canonicalised path, which on Windows carries
/// the extended-length prefix. Tesseract builds the data file path by
/// concatenating `--tessdata-dir` with `/eng.traineddata`, and Win32 does NOT
/// normalise verbatim paths: that forward slash stays a literal filename
/// character rather than a separator, so the open fails with
/// `Error opening data file \\?\...\tessdata/eng.traineddata` and Tesseract
/// exits 1 on every frame. A plain path goes through the usual normalisation.
#[cfg(windows)]
fn simplified(path: std::path::PathBuf) -> std::path::PathBuf {
    let plain = {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            Some(std::path::PathBuf::from(format!(r"\\{rest}")))
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            // Only a drive-letter path is safe to shorten; other verbatim
            // forms (device paths) may genuinely need the prefix.
            (rest.as_bytes().get(1) == Some(&b':')).then(|| std::path::PathBuf::from(rest))
        } else {
            None
        }
    };
    plain.unwrap_or(path)
}

#[cfg(not(windows))]
fn simplified(path: std::path::PathBuf) -> std::path::PathBuf {
    path
}

/// The Tesseract shipped in the app's resources, if it is complete.
///
/// `configs/tsv` is checked rather than just the executable because its absence
/// fails silently in the worst possible way: Tesseract ignores the unrecognised
/// config argument, prints PLAIN TEXT instead of TSV, and still exits 0.
/// `parse_tsv` then finds no word rows and reports empty text at 0.0
/// confidence, so every frame looks low-confidence and is routed to the llava
/// fallback — a slow, mysterious run instead of an error. Falling back to a
/// system install is far better than shipping into that.
fn bundled_tesseract(app: &tauri::AppHandle) -> Option<TesseractInstall> {
    let dir = simplified(app.path().resource_dir().ok()?).join("tesseract");

    let exe = dir.join(if cfg!(windows) { "tesseract.exe" } else { "tesseract" });
    let tessdata = dir.join("tessdata");

    if !exe.exists() {
        eprintln!(
            "[tesseract] no bundled copy at {}; falling back to a system install",
            exe.display()
        );
        return None;
    }
    if !tessdata.join("configs").join("tsv").exists() {
        eprintln!(
            "[tesseract] bundled copy at {} is missing tessdata/configs/tsv; \
             falling back to a system install",
            dir.display()
        );
        return None;
    }

    Some(TesseractInstall {
        exe,
        tessdata: Some(tessdata),
    })
}

/// Locate a system-installed `tesseract`, preferring an absolute path.
///
/// Resolution order (Windows):
///   1. Parent of `TESSDATA_PREFIX` env var (set by the UB-Mannheim installer)
///   2. `C:\Program Files\Tesseract-OCR\tesseract.exe`
///   3. `C:\Program Files (x86)\Tesseract-OCR\tesseract.exe`
///   4. `%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe` (user install)
///   5. `"tesseract"` — relies on PATH (Linux / macOS / unknown Windows layout)
fn resolve_system_tesseract_exe() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        // Strategy 1: TESSDATA_PREFIX is set by the UB-Mannheim installer and
        // points at the tessdata directory.  The exe is one level up.
        if let Ok(tessdata) = std::env::var("TESSDATA_PREFIX") {
            for ancestor in std::path::Path::new(&tessdata).ancestors().take(3) {
                let candidate = ancestor.join("tesseract.exe");
                if candidate.exists() {
                    return candidate;
                }
            }
        }

        // Strategy 2 & 3: standard system-wide install locations.
        let system_candidates = [
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        ];
        for &p in &system_candidates {
            let candidate = std::path::Path::new(p);
            if candidate.exists() {
                return candidate.to_path_buf();
            }
        }

        // Strategy 4: user-level install (no admin rights).
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let candidate = std::path::PathBuf::from(local)
                .join("Programs")
                .join("Tesseract-OCR")
                .join("tesseract.exe");
            if candidate.exists() {
                return candidate;
            }
        }
    }

    // Fallback: rely on PATH.  Works on Linux/macOS and Windows layouts
    // that don't match any of the above.
    std::path::PathBuf::from("tesseract")
}

/// Parse Tesseract's TSV output into a `TesseractResult`.
///
/// TSV columns (0-indexed):
///   0: level  1: page_num  2: block_num  3: par_num  4: line_num
///   5: word_num  6: left  7: top  8: width  9: height  10: conf  11: text
///
/// Only level-5 rows (individual words) with `conf >= 0` carry actual text.
fn parse_tsv(tsv: &str) -> Result<TesseractResult, String> {
    let mut text_parts: Vec<String> = Vec::new();
    let mut confidences: Vec<f32> = Vec::new();

    let mut prev_block: i32 = -1;
    let mut prev_line: i32 = -1;

    for line in tsv.lines().skip(1) {
        // Split on tab; guard against short/malformed rows.
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 12 {
            continue;
        }

        let level: i32 = cols[0].parse().unwrap_or(0);
        if level != 5 {
            continue; // only word-level rows
        }

        let conf: f32 = cols[10].parse().unwrap_or(-1.0);
        if conf < 0.0 {
            continue; // -1 marks structural / unrecognised rows
        }

        let word = cols[11]; // raw word text (may include trailing whitespace)
        if word.trim().is_empty() {
            continue;
        }

        let block: i32 = cols[2].parse().unwrap_or(0);
        let line_n: i32 = cols[4].parse().unwrap_or(0);

        // Insert paragraph or line breaks when the position changes.
        if !text_parts.is_empty() {
            if block != prev_block {
                text_parts.push("\n\n".to_string());
            } else if line_n != prev_line {
                text_parts.push("\n".to_string());
            } else {
                text_parts.push(" ".to_string());
            }
        }

        prev_block = block;
        prev_line = line_n;

        text_parts.push(word.to_string());
        confidences.push(conf);
    }

    let text = text_parts.concat().trim().to_string();

    let confidence = if confidences.is_empty() {
        0.0
    } else {
        confidences.iter().sum::<f32>() / confidences.len() as f32
    };

    Ok(TesseractResult { text, confidence })
}
