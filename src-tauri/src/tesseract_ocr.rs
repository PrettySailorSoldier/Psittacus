//! Tesseract OCR via the bundled sidecar binary.
//!
//! Runs `tesseract <image> stdout tsv` and parses the TSV output into a plain
//! text string plus a mean confidence score (0–100). The confidence is the
//! average of per-word `conf` values reported by Tesseract; structural rows
//! (level < 5 or conf == -1) are excluded from both the text and the average.
//!
//! The sidecar binary must be placed at `src-tauri/binaries/` under the name
//! `tesseract-<target-triple>` (e.g. `tesseract-x86_64-pc-windows-msvc.exe`),
//! and tessdata must live at `src-tauri/binaries/tessdata/`.

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

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
#[tauri::command]
pub async fn tesseract_ocr_image(
    app: AppHandle,
    path: String,
) -> Result<TesseractResult, String> {
    // Resolve the tessdata directory from the app's resource directory.
    // In dev mode this is `src-tauri/` (Tauri resolves resources there);
    // in production it is the bundled resource dir next to the executable.
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not resolve resource dir: {e}"))?;

    // tessdata lives one level inside the resource dir.
    let tessdata_dir = resource_dir.join("tessdata");
    let tessdata_str = tessdata_dir.to_string_lossy().to_string();

    // Run:  tesseract --tessdata-dir <dir> <image> stdout tsv
    let output = app
        .shell()
        .sidecar("binaries/tesseract")
        .map_err(|e| format!("Could not locate tesseract sidecar: {e}"))?
        .args([
            "--tessdata-dir",
            &tessdata_str,
            &path,
            "stdout", // write to stdout instead of a file
            "tsv",    // TSV config: gives per-word confidence column
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to spawn tesseract: {e}"))?;

    // Tesseract writes progress/warnings to stderr even on success; only treat
    // a non-zero exit code as a hard error.
    if output.status.code != Some(0) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Tesseract exited with code {:?}: {}",
            output.status.code,
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
