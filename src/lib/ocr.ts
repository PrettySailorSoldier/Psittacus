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
