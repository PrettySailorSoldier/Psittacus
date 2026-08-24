/**
 * Optional text-only cleanup pass over assembled OCR output.
 *
 * This runs *after* per-frame OCR, on the extracted text rather than on the
 * images, so it needs no vision model — a small instruct model is enough and
 * is an order of magnitude cheaper than a second llava pass over every frame.
 *
 * It targets two artifacts the per-frame pipeline cannot fix on its own:
 *
 *   1. Character-level OCR damage — word fragments, misread characters
 *      ("nt" where the page said "present"), stray punctuation and symbols.
 *   2. Cross-frame duplication — scroll-captured recordings overlap, so the
 *      same paragraph is transcribed two or three times with slightly
 *      different truncation at the edges. Perceptual frame dedup can't catch
 *      this (the frames genuinely differ) and the similarity-based text dedup
 *      only catches whole-segment repeats.
 *
 * The result is deliberately NOT written back over the raw extraction. Whether
 * cleanup helps or introduces its own errors is a per-document judgment call,
 * so `OutputView` shows both and lets the user pick.
 */

const OLLAMA_URL = 'http://localhost:11434/api/generate';

/**
 * Text-only instruct model. Explicitly not llava: this pass never sees an
 * image, and a vision model would be slower for no benefit.
 */
const CLEANUP_MODEL = 'llama3.2:3b';

/**
 * Frames per request. Small batches keep each prompt well inside the model's
 * effective context, where instruction-following stays reliable — a single
 * request carrying every frame tends to drift into summarising instead of
 * transcribing, which is the one thing this pass must not do.
 */
const FRAMES_PER_CHUNK = 3;

/** Hard character ceiling per request, applied before the frame count. */
const MAX_CHARS_PER_CHUNK = 6000;

/** How much of the previous cleaned chunk to show as overlap context. */
const CONTEXT_TAIL_CHARS = 500;

const SYSTEM_PROMPT = [
  'You are a transcription cleanup tool. You are given raw OCR output from',
  'several consecutive frames of a screen recording of a book or document.',
  'The frames overlap, so the SAME passage often appears two or three times.',
  '',
  'Produce ONE continuous clean version of the passage. Specifically:',
  '',
  '1. DEDUPLICATE. This is the most important task. The input repeats itself.',
  '   Where a sentence or paragraph appears more than once, output it EXACTLY',
  '   ONCE, keeping the most complete version. Merge a truncated copy into the',
  '   fuller copy rather than emitting both.',
  '2. DROP REPEATED UI LINES. Short lines that recur in every frame are the',
  '   reader application\'s navigation chrome, not document text (for example a',
  '   sidebar list, a page counter, or a running header). Remove every',
  '   occurrence of them.',
  '3. FIX OCR CHARACTER ERRORS where the intended word is unambiguous:',
  '   misread letters ("rnay" -> "may", "tirne" -> "time"), split or merged',
  '   words, stray symbols, spurious punctuation.',
  '4. REJOIN lines that OCR split mid-sentence. Keep real paragraph breaks.',
  '5. PRESERVE READING ORDER.',
  '',
  'Absolute rules — violating these makes the output useless:',
  '- Do NOT summarise, paraphrase, shorten, explain or rewrite the content.',
  '- Do NOT add any words, sentences, headings, notes or commentary of your own.',
  '- Do NOT complete, continue or "finish" a sentence that is cut off in the',
  '  input. Reproduce it cut off, exactly as given.',
  '- Preserve the author\'s exact wording everywhere it is legible.',
  '- If a passage is too garbled to repair confidently, leave it exactly as is.',
  '- Output ONLY the cleaned text. No preamble, no code fences, no closing remark.',
].join('\n');

/** Strip the wrapper text small models tend to add despite instructions. */
function stripPreamble(text: string): string {
  return text
    .replace(/```[\w]*\n?/g, '')
    .replace(/^(here is|here's)[^\n]*:?\n+/gi, '')
    .replace(/^(cleaned|corrected|the cleaned)[^\n]*text:?\n+/gi, '')
    .replace(/^sure[^\n]*\n+/gi, '')
    .trim();
}

/**
 * Group frame texts into request-sized chunks.
 *
 * A chunk closes when it reaches `FRAMES_PER_CHUNK` frames or would exceed
 * `MAX_CHARS_PER_CHUNK` characters, whichever comes first. A single frame that
 * is already over the ceiling becomes its own chunk rather than being split
 * mid-sentence — splitting inside a paragraph would hand the model half a
 * sentence and invite it to invent the other half.
 */
export function chunkFrameTexts(frameTexts: string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join('\n\n'));
      current = [];
      currentChars = 0;
    }
  };

  for (const raw of frameTexts) {
    const text = raw.trim();
    if (!text) continue; // blank frames carry nothing to clean

    if (current.length > 0 &&
        (current.length >= FRAMES_PER_CHUNK || currentChars + text.length > MAX_CHARS_PER_CHUNK)) {
      flush();
    }

    current.push(text);
    currentChars += text.length;
  }

  flush();
  return chunks;
}

/** Send one chunk to the model and return its cleaned text. */
async function cleanupChunk(chunk: string, previousTail: string): Promise<string> {
  // Showing the tail of the previous cleaned chunk lets the model drop a
  // paragraph that straddles the chunk boundary, which it otherwise cannot see.
  const contextBlock = previousTail
    ? `Text already emitted (for context only — do NOT repeat or re-output any of it):\n"""\n${previousTail}\n"""\n\n`
    : '';

  const prompt =
    `${SYSTEM_PROMPT}\n\n${contextBlock}Raw OCR text to clean:\n"""\n${chunk}\n"""\n\nCleaned text:`;

  let response: Response;
  try {
    response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        prompt,
        stream: false,
        options: {
          // Near-greedy decoding: this is a repair task, not a creative one.
          temperature: 0.1,
          top_p: 0.9,
          // Ollama defaults num_ctx to 2048 tokens regardless of what the model
          // supports. A full MAX_CHARS_PER_CHUNK chunk plus this prompt exceeds
          // that, and the overflow is silently truncated from the *start* — so
          // the model would clean text it can no longer see. Set it explicitly.
          num_ctx: 8192,
        },
      }),
    });
  } catch (e) {
    throw new Error(
      `Could not reach Ollama at ${OLLAMA_URL} (${e instanceof Error ? e.message : String(e)}). ` +
      `Make sure Ollama is running and the "${CLEANUP_MODEL}" model is pulled ` +
      `(ollama pull ${CLEANUP_MODEL}).`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // 404 from Ollama's generate endpoint means the model isn't pulled, which
    // is by far the most likely failure here and worth naming explicitly.
    if (response.status === 404) {
      throw new Error(
        `Ollama does not have the "${CLEANUP_MODEL}" model. Run: ollama pull ${CLEANUP_MODEL}`
      );
    }
    throw new Error(`Ollama returned ${response.status} ${response.statusText}. ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  return stripPreamble((data.response ?? '').trim());
}

/**
 * Clean up raw per-frame OCR output and return the assembled result.
 *
 * Chunks are processed in order and concatenated, so reading order is
 * preserved across the whole document.
 *
 * A chunk that fails to clean falls back to its raw text rather than
 * disappearing — a partially-cleaned document is far better than one with a
 * silent hole in the middle.
 */
export async function cleanupExtractedText(
  rawFrameTexts: string[],
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  const chunks = chunkFrameTexts(rawFrameTexts);

  if (chunks.length === 0) return '';

  console.log(`[Cleanup] ${rawFrameTexts.length} frame(s) -> ${chunks.length} chunk(s), model=${CLEANUP_MODEL}`);

  const cleaned: string[] = [];
  let firstFailure: Error | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const previousTail = cleaned.length > 0
      ? cleaned[cleaned.length - 1].slice(-CONTEXT_TAIL_CHARS)
      : '';

    try {
      const out = await cleanupChunk(chunks[i], previousTail);
      cleaned.push(out.length > 0 ? out : chunks[i]);
      console.log(`[Cleanup] chunk ${i + 1}/${chunks.length}: ${chunks[i].length} -> ${out.length} chars`);
    } catch (e) {
      if (!firstFailure) firstFailure = e instanceof Error ? e : new Error(String(e));
      console.error(`[Cleanup] chunk ${i + 1}/${chunks.length} failed, keeping raw text:`, e);
      cleaned.push(chunks[i]);
    }

    onProgress?.(i + 1, chunks.length);
  }

  // Every chunk failing means the backend is unreachable or the model is
  // missing. Returning the raw text unchanged would look like "cleanup ran and
  // found nothing to fix", so surface the real reason instead.
  if (firstFailure && cleaned.length === chunks.length &&
      cleaned.every((c, i) => c === chunks[i])) {
    throw firstFailure;
  }

  return cleaned.join('\n\n').trim();
}
