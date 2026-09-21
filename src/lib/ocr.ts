import { invoke } from '@tauri-apps/api/core';
import { deduplicateText } from './dedup';
import { structurePages } from './structure';


const OLLAMA_URL = 'http://localhost:11434/api/generate';
/**
 * Vision model used for the fallback leg.
 *
 * Was `llava` (LLaVA-1.5), whose vision tower is CLIP ViT-L at a fixed
 * 336x336. A 1080p book page scaled to 336px puts body text below one pixel
 * per stroke, so it could describe a page but not read one. qwen2.5vl uses
 * native dynamic resolution — the image is tiled rather than squashed — which
 * is what makes small print survive the encoder.
 *
 * Requires `ollama pull qwen2.5vl:7b` (~6 GB).
 */
const OLLAMA_MODEL = 'qwen2.5vl:7b';

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

// ── Hybrid pipeline (Windows OCR primary, qwen2.5vl fallback) ────────────────

/**
 * Minimum plausibility score to accept the Windows OCR result, on the 0–100
 * scale `windows_ocr.rs::plausibility` produces.
 *
 * IMPORTANT — this is NOT the same quantity the old Tesseract gate used, and
 * the old threshold does not carry over. Tesseract reported a real per-word
 * posterior from the recogniser. `Windows.Media.Ocr` exposes no confidence at
 * all, so the Rust side derives a proxy from the returned strings: the share
 * of words that look like language rather than symbol soup. Clean printed
 * pages score a flat 100 (measured: a 123-word synthetic book page scored
 * 100.0), so the useful threshold sits much higher than Tesseract's 60 — a
 * frame dipping even to 80 means a fifth of the output is junk.
 *
 * CAVEAT — the score measures precision, not recall, exactly as the Tesseract
 * gate did. Text the engine never saw cannot drag down an average computed
 * only from the text it returned, so a frame that yielded 6 words instead of
 * 400 can still score 100. `wordCount` is what catches that, which is why the
 * gate checks it below and the per-frame log reports it.
 */
const PRIMARY_PLAUSIBILITY_THRESHOLD = 85;

/**
 * Below this many words a frame is sent to the fallback regardless of score,
 * covering the recall blind spot above.
 *
 * Deliberately low: a legitimately sparse frame (a chapter opener, a page with
 * one line on it) should not be dragged through a 6 GB model for no reason.
 * This is meant to catch "the engine found almost nothing", not "this page is
 * short".
 */
const PRIMARY_MIN_WORDS = 3;

/** One recognised line and the union of its words' bounding boxes, in source-image pixels. */
export interface OcrLineBox {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A frame's line geometry together with the frame's own dimensions.
 *
 * The dimensions travel with the lines because every structural question is
 * relative to the page: whether a line sits in the bottom margin, whether it is
 * centred, how wide the text block is. Absolute pixel coordinates answer none
 * of those on their own.
 */
export interface OcrPageGeometry {
  lines: OcrLineBox[];
  imageWidth: number;
  imageHeight: number;
}

/** Shape of the result returned by the Rust windows_ocr_image command. */
interface WindowsOcrCommandResult {
  text: string;
  /** Plausibility proxy, not a recogniser confidence. See the threshold above. */
  confidence: number;
  wordCount: number;
  lines: OcrLineBox[];
  imageWidth: number;
  imageHeight: number;
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
  /**
   * Markdown reconstruction of the recording, with headings, paragraph breaks
   * and page furniture resolved from the geometry. Deduplicated the same way
   * `text` is.
   *
   * Falls back to the plain text of any frame the structure pass could not
   * analyse, so this is never *less* complete than `text` — only better
   * organised where the geometry allowed it.
   */
  structuredText: string;
  /**
   * Per-frame page geometry from the primary engine, in frame order, aligned
   * with `frameTexts`.
   *
   * Kept on the result so a caller can re-run or tune the structure pass
   * without re-running OCR over every frame.
   *
   * Empty lines for any frame answered by the fallback: a vision model returns
   * no trustworthy coordinates, so there is nothing honest to put here.
   */
  framePages: OcrPageGeometry[];
  /** Total frames that entered the OCR loop (already deduped). */
  framesProcessed: number;
  /** Frames that produced any non-empty text from either engine. */
  framesWithText: number;
  /** Frames handled successfully by Windows OCR alone. */
  framesViaWindowsOcr: number;
  /** Frames where Windows OCR was rejected and the vision model succeeded as fallback. */
  framesViaVisionModel: number;
  /**
   * Frames kept from rejected Windows OCR output because the fallback was
   * unreachable. Text was still produced; treat a high count as a sign that
   * the fallback is misconfigured, not that the run failed.
   */
  framesViaRejectedWindowsOcr: number;
  /** Frames where both engines failed (e.g. no OCR language pack + Ollama down). */
  framesFailedEntirely: number;
}

/**
 * Run OCR on `framePaths` using the built-in Windows recogniser as the primary
 * engine.
 *
 * Per-frame logic:
 *   1. Invoke `windows_ocr_image` (Tauri command → `Windows.Media.Ocr`).
 *   2. If plausibility ≥ threshold AND enough words were read → accept.
 *   3. Otherwise fall back to `ocrImage()` (qwen2.5vl via Ollama).
 *   4. If the fallback also fails → keep whatever the primary managed, or
 *      count the frame as entirely failed if it managed nothing.
 *
 * WHY WINDOWS OCR IS PRIMARY rather than the stronger-sounding vision model:
 * it is ~100x faster per frame, needs no model download or running server,
 * and — the part that matters for reproducing a book's layout — it returns a
 * bounding box per word. A vision model transcribes well but cannot tell you
 * where on the page anything sat, so it cannot distinguish a heading from body
 * text except by guessing from wording.
 *
 * Tesseract remains available as `tesseract_ocr_image` and is no longer in
 * this path; `runOcrPipeline` (vision-model-only) is likewise still here as a
 * manual escape hatch.
 */
export async function runHybridOcrPipeline(
  framePaths: string[],
  language: string,
  dedupeThreshold: number,
  onFrameDone: (frameIndex: number, text: string) => void
): Promise<HybridOcrResult> {
  const framesText: string[] = [];
  const framePages: OcrPageGeometry[] = [];
  let framesWithText = 0;
  let framesViaWindowsOcr = 0;
  let framesViaVisionModel = 0;
  let framesViaRejectedWindowsOcr = 0;
  let framesFailedEntirely = 0;
  let firstFailure: Error | null = null;
  // Why the primary was passed over, kept so a total failure can name the
  // first-line cause instead of only the fallback's symptom.
  let firstPrimaryError: string | null = null;
  let firstRejection: string | null = null;

  console.log(`[OCR] frames to process: ${framePaths.length}`);

  for (let i = 0; i < framePaths.length; i++) {
    const label = `${i + 1}/${framePaths.length}`;
    let text = '';
    let page: OcrPageGeometry = { lines: [], imageWidth: 0, imageHeight: 0 };

    // ── Step 1: Windows OCR ──────────────────────────────────────────────────
    let wResult: WindowsOcrCommandResult | null = null;
    try {
      wResult = await invoke<WindowsOcrCommandResult>('windows_ocr_image', {
        path: framePaths[i],
      });
    } catch (e) {
      console.warn(`[OCR] frame ${label}: windows OCR invocation error —`, e);
      if (!firstPrimaryError) firstPrimaryError = e instanceof Error ? e.message : String(e);
    }

    // Both halves of the gate matter, for different failure modes: the score
    // catches a frame read as garbage, the word count catches a frame the
    // engine barely read at all (which scores high on the little it found).
    const primaryAccepted =
      wResult !== null &&
      wResult.confidence >= PRIMARY_PLAUSIBILITY_THRESHOLD &&
      wResult.wordCount >= PRIMARY_MIN_WORDS &&
      wResult.text.trim().length > 0;

    // Unconditional per-frame decision log. Previously the accept path and the
    // fallback path each logged their own line, which made "no fallback lines
    // in the console" ambiguous between "the check never fires" and "the check
    // fires and always passes". One line per frame, always, removes that.
    console.log(
      `[OCR] frame ${label}: windows plausibility=` +
      `${wResult ? wResult.confidence.toFixed(1) : 'n/a (invocation failed)'}, ` +
      `threshold=${PRIMARY_PLAUSIBILITY_THRESHOLD}, ` +
      `words=${wResult ? wResult.wordCount : 0}/${PRIMARY_MIN_WORDS}, ` +
      `lines=${wResult ? wResult.lines.length : 0}, ` +
      `decision=${primaryAccepted ? 'windows' : 'fallback'}`
    );

    if (primaryAccepted && wResult) {
      text = wResult.text;
      page = { lines: wResult.lines, imageWidth: wResult.imageWidth, imageHeight: wResult.imageHeight };
      framesViaWindowsOcr++;
    } else {
      // ── Step 2: vision model fallback ──────────────────────────────────────
      if (wResult !== null) {
        // Windows OCR ran but the result did not clear the gate.
        if (!firstRejection) {
          firstRejection =
            `ran, but frame ${label} scored ${wResult.confidence.toFixed(1)} ` +
            `against a threshold of ${PRIMARY_PLAUSIBILITY_THRESHOLD} ` +
            `(${wResult.wordCount} word${wResult.wordCount === 1 ? '' : 's'} read)`;
        }
        console.log(
          `[OCR] frame ${label}: windows OCR rejected ` +
          `(score ${wResult.confidence.toFixed(1)}, ${wResult.wordCount} words), ` +
          `falling back to ${OLLAMA_MODEL}`
        );
      } else {
        // The command itself failed — no language pack, unreadable file, etc.
        console.log(
          `[OCR] frame ${label}: windows OCR unavailable, falling back to ${OLLAMA_MODEL}`
        );
      }

      try {
        text = await ocrImage(framePaths[i], language);
        // Left empty deliberately: the vision model reports no geometry, and
        // fabricating boxes would poison the structure pass downstream.
        page = { lines: [], imageWidth: 0, imageHeight: 0 };
        framesViaVisionModel++;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (!firstFailure) firstFailure = e instanceof Error ? e : new Error(String(e));

        // The fallback is gone, so the rejected Windows OCR output is now the
        // best available reading of this frame — keep it. Discarding it here
        // was strictly worse than imperfect text: a frame the primary had
        // actually read came out blank purely because the second opinion was
        // unreachable, and a run where the model is not pulled lost every
        // below-threshold frame rather than degrading.
        if (wResult !== null && wResult.text.trim().length > 0) {
          text = wResult.text;
          page = { lines: wResult.lines, imageWidth: wResult.imageWidth, imageHeight: wResult.imageHeight };
          framesViaRejectedWindowsOcr++;
          console.warn(
            `[OCR] frame ${label}: ${OLLAMA_MODEL} unavailable (${reason}); ` +
            `keeping rejected windows OCR text (score ${wResult.confidence.toFixed(1)})`
          );
        } else {
          console.error(`[OCR] frame ${label}: both engines failed — ${reason}`);
          framesFailedEntirely++;
          // text stays '' — push the empty string to keep indices aligned
        }
      }
    }

    if (text.trim().length > 0) framesWithText++;
    framesText.push(text);
    framePages.push(page);
    onFrameDone(i, text);
  }

  console.log(
    `[OCR] done — windows: ${framesViaWindowsOcr}, ` +
    `${OLLAMA_MODEL} fallback: ${framesViaVisionModel}, ` +
    `rejected windows text kept: ${framesViaRejectedWindowsOcr}, ` +
    `failed: ${framesFailedEntirely}`
  );

  // Every frame failing both engines means the primary was passed over AND the
  // fallback is unusable — not that the video had no text. `runOcrPipeline`
  // already guards this; without the same guard here the run "succeeds" into an
  // empty transcript and the real cause is only visible in the console.
  //
  // The report names BOTH layers. Throwing only the fallback's error blamed the
  // vision model for a run it was never meant to handle, and said nothing about
  // why the primary — the engine that should have done the work — was skipped
  // on every frame.
  if (framesFailedEntirely === framePaths.length && firstFailure) {
    const primaryStatus = firstPrimaryError
      ? `could not be started — ${firstPrimaryError}`
      : firstRejection
        ? firstRejection
        : 'was not used';

    throw new OcrBackendError(
      `OCR produced nothing on all ${framePaths.length} frame(s).\n\n` +
      `Windows OCR (primary): ${primaryStatus}.\n` +
      `${OLLAMA_MODEL} (fallback): ${firstFailure.message}\n\n` +
      (firstRejection
        ? 'A very low score with few or no words usually means the cropped ' +
          'area did not contain readable text — check the crop region before ' +
          'changing engines.'
        : 'Fix the primary engine first; the fallback is only meant for frames ' +
          'Windows OCR reads poorly.')
    );
  }

  // Structure is recovered per frame and then deduplicated exactly as the
  // plain text is, rather than being applied to the already-merged transcript.
  // Dedup drops whole frames, so doing it in this order means the geometry and
  // the text it describes are still talking about the same page.
  //
  // Frames the structure pass could not analyse (no geometry, i.e. answered by
  // the vision fallback) keep their plain text, so nothing is ever dropped from
  // the structured output that survives in the plain one.
  const structuredFrames = structurePages(framePages).map(
    (markdown, i) => (markdown.trim().length > 0 ? markdown : framesText[i])
  );

  return {
    text: deduplicateText(framesText, dedupeThreshold),
    structuredText: deduplicateText(structuredFrames, dedupeThreshold),
    frameTexts: framesText,
    framePages,
    framesProcessed: framesText.length,
    framesWithText,
    framesViaWindowsOcr,
    framesViaVisionModel,
    framesViaRejectedWindowsOcr,
    framesFailedEntirely,
  };
}
