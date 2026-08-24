//! Tesseract OCR via `std::process::Command`.
//!
//! Spawns the system-installed `tesseract` binary and parses the TSV output
//! it writes to stdout into a plain text string plus a mean confidence score.
//!
//! Using `std::process::Command` (rather than the tauri-plugin-shell sidecar
//! machinery) gives us full control over executable resolution. On Windows,
//! `STATUS_DLL_NOT_FOUND (0xC0000135)` can occur when the binary is found
//! through a PATH shim and the loader doesn't register the exe's own directory
//! as DLL search location #1. Resolving to the full absolute path avoids that.

/// Result returned to the frontend for each OCR'd frame.
#[derive(serde::Serialize)]
pub struct TesseractResult {
    /// The extracted text, with newlines reconstructed from line/block breaks.
    pub text: String,
    /// Mean per-word confidence reported by Tesseract, in the range 0–100.
    /// 0.0 means no words were recognised (blank or image-only frame).
    pub confidence: f32,
}

/// Run Tesseract on a single image file and return the extracted text with
/// its mean confidence score.
///
/// Calls `tesseract <path> stdout tsv` on a blocking thread (OCR is CPU-bound
/// and `std::process::Command::output()` is synchronous).
#[tauri::command]
pub async fn tesseract_ocr_image(
    _app: tauri::AppHandle,
    path: String,
) -> Result<TesseractResult, String> {
    let output = tauri::async_runtime::spawn_blocking(move || {
        let exe = resolve_tesseract_exe();
        std::process::Command::new(&exe)
            .args([path.as_str(), "stdout", "tsv"])
            .output()
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

/// Locate the `tesseract` executable, preferring an absolute path.
///
/// On Windows, an absolute path is critical: the Windows DLL loader uses the
/// executable's own directory as its first DLL search location only when the
/// process is started with an absolute path. A PATH-shim lookup can skip that
/// step, producing `STATUS_DLL_NOT_FOUND (0xC0000135)` for co-located DLLs.
///
/// Resolution order (Windows):
///   1. Parent of `TESSDATA_PREFIX` env var (set by the UB-Mannheim installer)
///   2. `C:\Program Files\Tesseract-OCR\tesseract.exe`
///   3. `C:\Program Files (x86)\Tesseract-OCR\tesseract.exe`
///   4. `%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe` (user install)
///   5. `"tesseract"` — relies on PATH (Linux / macOS / unknown Windows layout)
fn resolve_tesseract_exe() -> std::path::PathBuf {
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
