//! Tesseract OCR via `std::process::Command`.
//!
//! Spawns the system-installed `tesseract` binary (expected to be on PATH —
//! the UB-Mannheim installer adds it automatically) and parses the TSV output
//! it writes to stdout. Using the system binary avoids the `ERROR_PATH_NOT_FOUND`
//! that tauri-plugin-shell's sidecar spawn produces on Windows when the shell
//! plugin sets an internal working directory that doesn't match the binary's
//! expected DLL search paths.
//!
//! The `parse_tsv` function and `TesseractResult` type are shared with
//! any future sidecar-based variant; only the spawn call changes here.

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
/// and `std::process::Command::output()` is synchronous). Tesseract locates
/// its `tessdata/` relative to its own executable, so no `--tessdata-dir` arg
/// is required when using the system install.
#[tauri::command]
pub async fn tesseract_ocr_image(
    _app: tauri::AppHandle,
    path: String,
) -> Result<TesseractResult, String> {
    // Offload the blocking process::Command::output() call off the async executor.
    let output = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("tesseract")
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
