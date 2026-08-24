import { invoke } from '@tauri-apps/api/core';
import { deduplicateText } from './dedup';


const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'llava';

/** Raised when the OCR backend itself is unusable, as opposed to a frame simply having no text. */
export class OcrBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrBackendError';
  }
}

export interface OcrResult {
  text: string;
  /** Frames actually put through OCR. Counted in the OCR loop itself. */
  framesProcessed: number;
  /** Frames that came back with usable text. */
  framesWithText: number;
  /** Frames whose OCR call failed outright. */
  framesFailed: number;
}

async function imageToBase64(imagePath: string): Promise<string> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(imagePath);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function cleanResponse(text: string): string {
  return text
    .replace(/```[\w]*\n?/g, '')        // strip code fences
    .replace(/^The image (shows|displays|contains|depicts)[^\n]*\n?/gim, '')
    .replace(/^Here is the (extracted )?text:?\n?/gim, '')
    .replace(/^I can see[^\n]*\n?/gim, '')
    .replace(/^This (image|screenshot|document)[^\n]*\n?/gim, '')
    .trim();
}

export async function ocrImage(imagePath: string, _language: string): Promise<string> {
  const base64 = await imageToBase64(imagePath);

  let response: Response;
  try {
    response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: 'Transcribe only the document text visible in this image. Do not describe the image. Do not add any commentary. Do not use code blocks. Output only the raw text exactly as it appears, preserving headings and paragraphs.',
        images: [base64],
        stream: false,
      }),
    });
  } catch (e) {
    // Connection refused, DNS, timeout: the backend is down, not the frame's fault.
    throw new OcrBackendError(
      `Could not reach Ollama at ${OLLAMA_URL} (${e instanceof Error ? e.message : String(e)}). ` +
      `Make sure Ollama is running and the "${OLLAMA_MODEL}" model is pulled.`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new OcrBackendError(
      `Ollama returned ${response.status} ${response.statusText}. ${body.slice(0, 300)}`
    );
  }

  const data = await response.json();
  // An empty string here is a real answer: this frame had no readable text.
  return cleanResponse((data.response ?? '').trim());
}

export async function runOcrPipeline(
  framePaths: string[],
  language: string,
  dedupeThreshold: number,
  onFrameDone: (frameIndex: number, text: string) => void
): Promise<OcrResult> {
  const framesText: string[] = [];
  let framesWithText = 0;
  let framesFailed = 0;
  let firstFailure: Error | null = null;

  console.log('[OCR] frames to process:', framePaths.length);

  for (let i = 0; i < framePaths.length; i++) {
    let text = '';
    try {
      text = await ocrImage(framePaths[i], language);
      if (text.trim().length > 0) framesWithText++;
    } catch (e) {
      // One bad frame shouldn't end the run: record it, keep the index
      // aligned by pushing an empty string, and carry on.
      framesFailed++;
      if (!firstFailure) firstFailure = e instanceof Error ? e : new Error(String(e));
      console.error(`[OCR] frame ${i + 1}/${framePaths.length} failed:`, e);
    }

    framesText.push(text);
    onFrameDone(i, text);
  }

  console.log('[OCR] results collected:', framesText.length);
  console.log(
    `[OCR] ${framesWithText} frame(s) with text, ${framesFailed} failed, ` +
    `${framesText.length - framesWithText - framesFailed} blank`
  );

  // Previously every failure was swallowed into an empty string, so a backend
  // that was flat-out down looked identical to "the video had no text".
  if (framesFailed === framePaths.length && firstFailure) {
    throw firstFailure;
  }

  return {
    text: deduplicateText(framesText, dedupeThreshold),
    framesProcessed: framesText.length,
    framesWithText,
    framesFailed,
  };
}

// ── Hybrid pipeline (Tesseract primary, llava fallback) ───────────────────────

/**
 * Minimum mean per-word Tesseract confidence to accept its result, on
 * Tesseract's native 0–100 scale (matching `TesseractResult.confidence`,
 * which `parse_tsv` computes as the mean of the TSV `conf` column).
 *
 * Measured behaviour on clean printed textbook pages: mean confidence sits at
 * 94–96, with per-word values spread across 0–97. Nothing near this threshold.
 * That is why a normal run logs `decision=tesseract` on every frame and no
 * llava fallback lines appear — the gate is working, the input is just easy.
 *
 * The gate does fire on genuinely bad input: degrading a frame until Tesseract
 * can barely read it drops the mean to 55.6, and an unreadable frame reports
 * 0.0, both routing to llava.
 *
 * Raise this toward ~85 to push more borderline frames to llava (slower, but
 * llava handles low-res and handwriting far better); lower it toward ~40 to
 * keep more frames on Tesseract when llava is unavailable or too slow.
 *
 * CAVEAT — this score measures precision, not recall. Tesseract only reports
 * confidence for words it actually recognised; text it misses entirely never
 * enters the average. A blurred frame that yielded 7 words instead of 197
 * still scored 96.1 and was accepted. If messier source material starts going
 * through this pipeline, a low word count is the signal to watch, not a low
 * confidence — which is why the per-frame log below reports `words=` too.
 */
const TESSERACT_CONFIDENCE_THRESHOLD = 60;

/** Shape of the result returned by the Rust tesseract_ocr_image command. */
interface TesseractCommandResult {
  text: string;
  confidence: number;
}

/** Extended result for the hybrid pipeline — distinguishes engine sources. */
export interface HybridOcrResult {
  text: string;
  /**
   * Per-frame OCR output, in frame order, before text-level dedup is applied.
   * Kept so the optional cleanup pass (`lib/textCleanup.ts`) can work from the
   * raw extraction, and so the raw result stays available to the user rather
   * than being replaced by any downstream transform.
   */
  frameTexts: string[];
  /** Total frames that entered the OCR loop (already deduped). */
  framesProcessed: number;
  /** Frames that produced any non-empty text from either engine. */
  framesWithText: number;
  /** Frames handled successfully by Tesseract alone. */
  framesViaTesseract: number;
  /** Frames where Tesseract was low-confidence and llava succeeded as fallback. */
  framesViaLlava: number;
  /** Frames where both engines failed (e.g. Tesseract error + Ollama down). */
  framesFailedEntirely: number;
}

/**
 * Run OCR on `framePaths` using Tesseract as the primary engine.
 *
 * Per-frame logic:
 *   1. Invoke `tesseract_ocr_image` (Tauri command → bundled sidecar).
 *   2. If confidence ≥ threshold AND text is non-empty → accept, skip llava.
 *   3. If confidence is low OR text is empty → fall back to `ocrImage()` (llava).
 *   4. If llava also fails → log clearly, count the frame as entirely failed.
 *
 * `runOcrPipeline` (llava-only) is intentionally left in place as a manual
 * fallback in case the Tesseract sidecar is unavailable.
 */
export async function runHybridOcrPipeline(
  framePaths: string[],
  language: string,
  dedupeThreshold: number,
  onFrameDone: (frameIndex: number, text: string) => void
): Promise<HybridOcrResult> {
  const framesText: string[] = [];
  let framesWithText = 0;
  let framesViaTesseract = 0;
  let framesViaLlava = 0;
  let framesFailedEntirely = 0;

  console.log(`[OCR] frames to process: ${framePaths.length}`);

  for (let i = 0; i < framePaths.length; i++) {
    const label = `${i + 1}/${framePaths.length}`;
    let text = '';

    // ── Step 1: Tesseract ────────────────────────────────────────────────────
    let tResult: TesseractCommandResult | null = null;
    try {
      tResult = await invoke<TesseractCommandResult>('tesseract_ocr_image', {
        path: framePaths[i],
      });
    } catch (e) {
      console.warn(`[OCR] frame ${label}: tesseract invocation error —`, e);
    }

    const tesseractAccepted =
      tResult !== null &&
      tResult.confidence >= TESSERACT_CONFIDENCE_THRESHOLD &&
      tResult.text.trim().length > 0;

    // Unconditional per-frame decision log. Previously the accept path and the
    // fallback path each logged their own line, which made "no fallback lines
    // in the console" ambiguous between "the check never fires" and "the check
    // fires and always passes". One line per frame, always, removes that.
    console.log(
      `[OCR] frame ${label}: tesseract confidence=` +
      `${tResult ? tResult.confidence.toFixed(1) : 'n/a (invocation failed)'}, ` +
      `threshold=${TESSERACT_CONFIDENCE_THRESHOLD}, ` +
      `words=${tResult ? tResult.text.trim().split(/\s+/).filter(Boolean).length : 0}, ` +
      `decision=${tesseractAccepted ? 'tesseract' : 'fallback'}`
    );

    if (tesseractAccepted && tResult) {
      text = tResult.text;
      framesViaTesseract++;
    } else {
      // ── Step 2: llava fallback ─────────────────────────────────────────────
      if (tResult !== null) {
        // Tesseract ran but confidence was too low (or returned no text)
        console.log(
          `[OCR] frame ${label}: tesseract low-confidence ` +
          `(${tResult.confidence.toFixed(1)}), falling back to llava`
        );
      } else {
        // Tesseract failed to run at all (sidecar missing / spawn error)
        console.log(`[OCR] frame ${label}: tesseract unavailable, falling back to llava`);
      }

      try {
        text = await ocrImage(framePaths[i], language);
        framesViaLlava++;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`[OCR] frame ${label}: both engines failed — ${reason}`);
        framesFailedEntirely++;
        // text stays '' — push the empty string to keep indices aligned
      }
    }

    if (text.trim().length > 0) framesWithText++;
    framesText.push(text);
    onFrameDone(i, text);
  }

  console.log(
    `[OCR] done — tesseract: ${framesViaTesseract}, ` +
    `llava fallback: ${framesViaLlava}, ` +
    `failed: ${framesFailedEntirely}`
  );

  return {
    text: deduplicateText(framesText, dedupeThreshold),
    frameTexts: framesText,
    framesProcessed: framesText.length,
    framesWithText,
    framesViaTesseract,
    framesViaLlava,
    framesFailedEntirely,
  };
}
