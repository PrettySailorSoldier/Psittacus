//! OCR via `Windows.Media.Ocr` — the recognizer built into Windows 10/11.
//!
//! Unlike Tesseract this needs no bundled executable, no DLLs and no model
//! files: the engine ships with the OS and is reached through WinRT, so there
//! is nothing to stage into `resources` and nothing to spawn. It is also
//! roughly two orders of magnitude faster per frame than a vision LLM, which
//! matters when a single recording produces hundreds of frames.
//!
//! WHY IT IS THE PRIMARY ENGINE: it returns a bounding rectangle for every
//! word. Telling a chapter heading from body text from a page number is a
//! question about geometry — glyph height against the page median, position in
//! the margin, centring, the size of vertical gaps — not about the characters
//! themselves. A vision LLM transcribes well but reports no trustworthy
//! coordinates, so it cannot answer that question at all. The geometry is
//! returned to the frontend for that reason; see `OcrLineBox`.
//!
//! LIMITS worth knowing before trusting a result:
//!   * No per-word confidence. Windows simply does not expose one, so
//!     `plausibility` below is a *substitute* computed from the returned text.
//!     Read its docs before using it as a gate — it is not a model confidence
//!     and must not be compared against Tesseract's.
//!   * Language support is whatever OCR packs are installed
//!     (Settings → Time & language → Language & region → Optional features).
//!     A machine with no usable pack fails at engine creation, not per frame.
//!   * Images above `OcrEngine::MaxImageDimension` (10000px) are rejected.

/// One recognised line, with the union of its words' bounding boxes.
///
/// Coordinates are in pixels of the source image, origin top-left. They are
/// returned alongside `image_width`/`image_height` so the frontend can reason
/// in page-relative terms (is this line in the bottom margin? is it centred?)
/// without having to re-open the frame to find out how big it was.
#[derive(serde::Serialize)]
pub struct OcrLineBox {
    pub text: String,
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

/// Result returned to the frontend for each OCR'd frame.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsOcrResult {
    /// All recognised text, lines joined with `\n` in the order Windows
    /// returned them.
    pub text: String,
    /// A 0–100 *text plausibility* score. See `plausibility` — this is NOT a
    /// recogniser confidence.
    pub confidence: f32,
    /// Number of words recognised. The more honest health signal of the two:
    /// see the caveat on `plausibility`.
    pub word_count: usize,
    /// Per-line text and geometry, for the structure pass.
    pub lines: Vec<OcrLineBox>,
    pub image_width: u32,
    pub image_height: u32,
}

/// Run the Windows OCR engine over a single image file.
///
/// Blocking WinRT work is pushed onto a blocking thread: every `.get()` below
/// parks the calling thread until the async operation completes, which would
/// otherwise stall the async runtime for the whole frame.
#[tauri::command]
pub async fn windows_ocr_image(path: String) -> Result<WindowsOcrResult, String> {
    tauri::async_runtime::spawn_blocking(move || recognize(&path))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[cfg(windows)]
fn recognize(path: &str) -> Result<WindowsOcrResult, String> {
    use windows::core::HSTRING;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    // WinRT activation requires an initialised apartment. `spawn_blocking`
    // hands out fresh pool threads, so this runs per call; a thread that is
    // already initialised returns RPC_E_CHANGED_MODE / S_FALSE, both of which
    // are fine to ignore — we only need *an* apartment, not a particular one.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };

    // `GetFileFromPathAsync` wants a fully-qualified Win32 path and rejects
    // forward slashes outright. Frame paths are produced by ffmpeg and Tauri's
    // temp-dir helpers, which mix separators depending on who built them.
    let native_path = path.replace('/', "\\");

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(native_path.as_str()))
        .and_then(|op| op.get())
        .map_err(|e| format!("Could not open {native_path}: {}", e.message()))?;

    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .and_then(|op| op.get())
        .map_err(|e| format!("Could not read {native_path}: {}", e.message()))?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .and_then(|op| op.get())
        .map_err(|e| format!("Could not decode {native_path} as an image: {}", e.message()))?;

    let image_width = decoder.PixelWidth().unwrap_or(0);
    let image_height = decoder.PixelHeight().unwrap_or(0);

    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .and_then(|op| op.get())
        .map_err(|e| format!("Could not load pixels from {native_path}: {}", e.message()))?;

    // Fails when no OCR language pack is installed — a machine-level problem,
    // so say so rather than letting it read as a bad frame.
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| {
        format!(
            "Windows OCR has no usable language for this user profile ({}). \
             Add one under Settings → Time & language → Language & region → \
             your language → Optional features → Optical character recognition.",
            e.message()
        )
    })?;

    let result = engine
        .RecognizeAsync(&bitmap)
        .and_then(|op| op.get())
        .map_err(|e| format!("Windows OCR failed on {native_path}: {}", e.message()))?;

    let mut lines: Vec<OcrLineBox> = Vec::new();
    let mut words: Vec<String> = Vec::new();

    for line in result.Lines().map_err(|e| e.message())? {
        // Word-by-word rather than `OcrLine::Text()` because the same pass has
        // to union the bounding boxes anyway, and reading both from one source
        // keeps text and geometry from drifting apart.
        //
        // Joining on a space assumes a space-delimited script. That holds for
        // the Latin packs this app targets; CJK packs would need the line's
        // own `Text()` instead.
        let mut line_words: Vec<String> = Vec::new();
        let (mut l, mut t) = (f32::MAX, f32::MAX);
        let (mut r, mut b) = (f32::MIN, f32::MIN);

        for word in line.Words().map_err(|e| e.message())? {
            let text = word.Text().map_err(|e| e.message())?.to_string_lossy();
            if text.trim().is_empty() {
                continue;
            }
            if let Ok(rect) = word.BoundingRect() {
                l = l.min(rect.X);
                t = t.min(rect.Y);
                r = r.max(rect.X + rect.Width);
                b = b.max(rect.Y + rect.Height);
            }
            line_words.push(text.clone());
            words.push(text);
        }

        if line_words.is_empty() {
            continue;
        }

        lines.push(OcrLineBox {
            text: line_words.join(" "),
            left: l,
            top: t,
            width: (r - l).max(0.0),
            height: (b - t).max(0.0),
        });
    }

    let text = lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");

    Ok(WindowsOcrResult {
        confidence: plausibility(&words),
        word_count: words.len(),
        text,
        lines,
        image_width,
        image_height,
    })
}

#[cfg(not(windows))]
fn recognize(_path: &str) -> Result<WindowsOcrResult, String> {
    Err("Windows OCR is only available on Windows".to_string())
}

/// A 0–100 stand-in for the confidence Windows does not report.
///
/// This measures how much of the output *looks like language*: the share of
/// words that contain at least one alphanumeric character and are not mostly
/// symbol soup. Clean printed text scores at or near 100; a frame where the
/// recogniser latched onto JPEG noise or UI chrome scores far lower.
///
/// TWO THINGS IT IS NOT:
///   1. Not comparable to Tesseract's `conf` column. That is a per-word
///      posterior from the recogniser itself; this is a post-hoc guess made
///      from the strings. Do not reuse a threshold tuned against one for the
///      other.
///   2. Not a measure of recall — the same blind spot the Tesseract gate has.
///      Text the engine never saw cannot lower a score computed only from the
///      text it returned, so a frame that yielded 6 words instead of 400 can
///      still score 100. `word_count` is the signal that catches that case,
///      which is why it is returned separately and logged per frame.
fn plausibility(words: &[String]) -> f32 {
    if words.is_empty() {
        return 0.0;
    }

    let plausible = words
        .iter()
        .filter(|w| {
            let chars: Vec<char> = w.chars().collect();
            if !chars.iter().any(|c| c.is_alphanumeric()) {
                return false;
            }
            // Ordinary prose is mostly letters and digits with a little
            // punctuation hanging off it. A token that is more than half
            // symbols is far more likely to be a misread.
            let ordinary = chars
                .iter()
                .filter(|c| c.is_alphanumeric() || SAFE_PUNCTUATION.contains(**c))
                .count();
            ordinary * 2 > chars.len()
        })
        .count();

    100.0 * plausible as f32 / words.len() as f32
}

/// Punctuation that appears in correctly-read printed text and so should not
/// count against a word's plausibility.
const SAFE_PUNCTUATION: &str = ".,;:'\"!?()[]{}-—–…&/%$#@*+=<>|~`^_\\";

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn plausibility_rewards_prose_and_punishes_symbol_soup() {
        let prose: Vec<String> = "The quick brown fox, jumped over 17 lazy dogs."
            .split_whitespace()
            .map(String::from)
            .collect();
        assert_eq!(plausibility(&prose), 100.0);

        let soup: Vec<String> = vec!["|~^", "}{><", "#@*"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(plausibility(&soup), 0.0);

        assert_eq!(plausibility(&[]), 0.0);
    }

    /// End-to-end against the real OS engine.
    ///
    /// Point `PSITTACUS_TEST_IMAGE` at an image to run it; skipped otherwise so
    /// the suite still passes on a machine with no OCR language pack.
    #[test]
    fn reads_a_real_image() {
        let Ok(path) = std::env::var("PSITTACUS_TEST_IMAGE") else {
            eprintln!("PSITTACUS_TEST_IMAGE not set — skipping");
            return;
        };

        let result = recognize(&path).expect("OCR should succeed");
        // Emitted so the frontend structure pass can be exercised against real
        // engine geometry instead of hand-written fixtures.
        eprintln!("JSON:{}", serde_json::to_string(&result).unwrap());
        eprintln!(
            "image={}x{} words={} plausibility={:.1}",
            result.image_width, result.image_height, result.word_count, result.confidence
        );
        for line in &result.lines {
            eprintln!(
                "  [h={:5.1} top={:6.1} left={:6.1} w={:6.1}] {}",
                line.height, line.top, line.left, line.width, line.text
            );
        }
        assert!(result.word_count > 0, "expected to read some text");
    }
}
