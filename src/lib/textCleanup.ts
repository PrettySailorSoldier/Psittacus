/**
 * Optional text-only cleanup pass over assembled OCR output.
 *
 * This runs *after* per-frame OCR, on the extracted text rather than on the
 * images, so it needs no vision model — a small instruct model is enough and
 * is an order of magnitude cheaper than a second llava pass over every frame.
 *
 * It targets character-level OCR damage the per-frame pipeline cannot fix on
 * its own — word fragments, misread characters ("nt" where the page said
 * "present"), stray punctuation and symbols.
 *
 * It works on the stitched Markdown transcript, not on raw per-frame text.
 * It used to take the raw frames and was asked to deduplicate them too, which
 * failed two ways on a real run: the model only saw three frames per request,
 * so repeats across a request boundary survived (one section appeared three
 * times); and the frames carried no structure, so headings came out flat and
 * list numbers the engine had returned out of order were simply deleted.
 * Overlap is now resolved by `dedup.ts::stitchFrames` before this runs.
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
 * Character ceiling per request. Small requests keep each prompt well inside
 * the model's effective context, where instruction-following stays reliable —
 * a long request tends to drift into summarising instead of transcribing,
 * which is the one thing this pass must not do.
 */
const MAX_CHARS_PER_CHUNK = 3000;

const SYSTEM_PROMPT = [
  'You are a transcription cleanup tool. You are given part of a book or',
  'document that was transcribed by OCR and formatted as Markdown.',
  '',
  'Repair OCR damage and nothing else. Specifically:',
  '',
  '1. FIX OCR CHARACTER ERRORS where the intended word is unambiguous:',
  '   misread letters ("rnay" -> "may", "tirne" -> "time"), split or merged',
  '   words, stray symbols, spurious punctuation.',
  '2. If the same sentence or paragraph appears twice in a row, keep it once.',
  '3. KEEP THE MARKDOWN EXACTLY AS GIVEN. Every heading ("#", "##"), list',
  '   marker ("1.", "-") and its indentation, table row ("| a | b |"), quote',
  '   marker (">"), "---" separator and blank line stays where it is. Never',
  '   remove a line because it is short, in capitals, or looks like a label.',
  '',
  'Absolute rules — violating these makes the output useless:',
  '- Do NOT summarise, paraphrase, shorten, explain or rewrite the content.',
  '- Do NOT add any words, sentences, headings, notes or commentary of your own.',
  '  Never insert a word that is not in the input, even one that seems missing.',
  '- Do NOT complete, continue or "finish" a sentence that is cut off in the',
  '  input. Reproduce it cut off, exactly as given.',
  '- Preserve the author\'s exact wording everywhere it is legible.',
  '- If a passage is too garbled to repair confidently, leave it exactly as is.',
  '- Output ONLY the cleaned text. No preamble, no code fences, no closing remark.',
].join('\n');

/** Strip the wrapper text small models tend to add despite instructions. */
export function stripPreamble(text: string): string {
  return text
    .replace(/```[\w]*\n?/g, '')
    // The prompt's own """ delimiters, echoed back.
    .replace(/^\s*"""\s*$/gm, '')
    .replace(/^(here is|here's)[^\n]*:?\n+/gi, '')
    .replace(/^(cleaned|corrected|the cleaned)[^\n]*text:?\n+/gi, '')
    .replace(/^sure[^\n]*\n+/gi, '')
    // A trailing note in the model's own voice ("Note: I removed the repeated
    // lines … If you want me to rejoin the lines, please let me know.").
    .replace(/\n+\(?Note:[^\n]*\b(?:I|me|you)\b[\s\S]*$/i, '')
    .trim();
}

/**
 * Remove quote marks the model wrapped around its answer.
 *
 * The prompt delimits the input with """, and the model sometimes echoes part
 * of that fused to the first or last word — on a real run `"Plus; 7/28/2029`
 * and `$481.10"`, which `stripPreamble` misses because the quote does not sit
 * on a line of its own. Only stripped where the input had no quote there.
 */
export function stripStrayQuotes(output: string, input: string): string {
  let out = output;
  if (/^["“”]/.test(out) && !/^\s*["“”]/.test(input)) out = out.replace(/^["“”]{1,3}/, '');
  if (/["“”]$/.test(out) && !/["“”]\s*$/.test(input)) out = out.replace(/["“”]{1,3}$/, '');
  return out.trim();
}

/**
 * Longest run of inserted words `dropInsertedWords` removes. A longer run is
 * more likely a sentence the model moved than one it made up, and removing it
 * would lose text, so it is left in place.
 */
const MAX_DROPPED_INSERTION = 3;

/**
 * Undo short insertions: words in the output with no counterpart at all in
 * the input.
 *
 * The output is aligned against the input word by word. A run of output words
 * opposite one or more input words is a repair (a misread word, a split or a
 * merge) and is kept. A run opposite nothing is new text. On a real run the
 * model turned "you will create the transactions" into "you will create the
 * necessary transactions", borrowing a word from a nearby line; that word is
 * opposite nothing, and is removed here.
 */
export function dropInsertedWords(output: string, input: string): string {
  const normalise = (token: string) => token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const source = input.split(/\s+/).map(normalise).filter(Boolean);
  // Each token keeps its trailing whitespace, so removing one leaves the
  // surrounding layout (line breaks, indentation) intact.
  const tokens = [...output.matchAll(/\S+\s*/g)].map(m => ({ raw: m[0], norm: normalise(m[0]) }));
  const words = tokens.map((t, i) => ({ ...t, i })).filter(t => t.norm);

  const n = words.length;
  const m = source.length;
  if (n === 0 || m === 0 || n * m > 4_000_000) return output;

  // Longest common subsequence over normalised words.
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = words[i].norm === source[j]
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  // Walk the alignment. `pending` collects output words matched to nothing;
  // when the next match arrives, they were a pure insertion if no input word
  // was skipped in the same stretch.
  const drop = new Set<number>();
  let pending: number[] = [];
  let skippedInput = false;
  const settle = () => {
    if (!skippedInput && pending.length > 0 && pending.length <= MAX_DROPPED_INSERTION) {
      for (const index of pending) drop.add(index);
    }
    pending = [];
    skippedInput = false;
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (words[i].norm === source[j]) {
      settle();
      i++;
      j++;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      pending.push(words[i].i);
      i++;
    } else {
      skippedInput = true;
      j++;
    }
  }
  while (i < n) pending.push(words[i++].i);
  if (j < m) skippedInput = true;
  settle();

  if (drop.size === 0) return output;
  console.log(`[Cleanup] removed inserted word(s): ${[...drop].map(k => tokens[k].raw.trim()).join(', ')}`);
  return tokens.filter((_, k) => !drop.has(k)).map(t => t.raw).join('');
}

/**
 * Longest acceptable output, as a multiple of the input's length.
 *
 * Cleanup removes duplicated passages and fixes characters; it should never
 * make a chunk meaningfully longer. Output that grows is the model writing
 * its own text — on a real run, an invented sentence repeated seven times.
 */
const MAX_GROWTH = 1.15;

/** A sentence this many times in one chunk's output is a generation loop. */
const MAX_SENTENCE_REPEATS = 3;

/**
 * Why a chunk's cleaned output should be discarded, or null if it passes.
 *
 * These checks catch runaway generation, not every invention: a model that
 * quietly rewrites one clause ("passes once the goods are shipped" for
 * "passes once Ishmael delivers the goods to a carrier") produces text of the
 * right length with no repeats, and no check here can tell. That is why the
 * raw extraction is always kept alongside the cleaned version.
 */
export function rejectReason(output: string, input: string): string | null {
  if (output.length > input.length * MAX_GROWTH) {
    return `output grew from ${input.length} to ${output.length} chars`;
  }

  const counts = new Map<string, number>();
  for (const sentence of output.split(/(?<=[.!?])\s+/)) {
    const key = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
    if (key.split(' ').length < 6) continue;
    const n = (counts.get(key) ?? 0) + 1;
    if (n >= MAX_SENTENCE_REPEATS) return `sentence repeated ${n} times: "${key.slice(0, 60)}…"`;
    counts.set(key, n);
  }

  return null;
}

/**
 * Split the transcript into request-sized chunks at block boundaries.
 *
 * A chunk closes before it would exceed `MAX_CHARS_PER_CHUNK`. A single block
 * already over the ceiling becomes its own chunk rather than being split
 * mid-sentence — splitting inside a paragraph would hand the model half a
 * sentence and invite it to invent the other half.
 */
export function chunkText(text: string): string[] {
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

  for (const raw of text.split(/\n{2,}/)) {
    const block = raw.replace(/\s+$/, '');
    if (!block.trim()) continue;

    if (current.length > 0 && currentChars + block.length > MAX_CHARS_PER_CHUNK) flush();
    current.push(block);
    currentChars += block.length;
  }

  flush();
  return chunks;
}

/**
 * Send one chunk to the model and return its cleaned text.
 *
 * The chunk is sent alone. Each request used to carry the tail of the previous
 * one so the model could drop a paragraph repeated across the boundary; that
 * repetition is now resolved by stitching, and on a real run the model copied
 * the context back out at the head of its answer.
 */
async function cleanupChunk(chunk: string): Promise<string> {
  const prompt = `${SYSTEM_PROMPT}\n\nRaw OCR text to clean:\n"""\n${chunk}\n"""\n\nCleaned text:`;

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
          // Stop a generation loop instead of letting it run to the context
          // limit. English OCR text runs ~4 chars per token, so chars/3 leaves
          // a third of headroom over an output the same length as the input.
          num_predict: Math.ceil(chunk.length / 3) + 64,
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
  const cleaned = stripStrayQuotes(stripPreamble((data.response ?? '').trim()), chunk);
  return dropInsertedWords(cleaned, chunk);
}

/**
 * Clean up the stitched transcript and return the result.
 *
 * Chunks are processed in order and concatenated, so reading order is
 * preserved across the whole document.
 *
 * A chunk that fails to clean falls back to its raw text rather than
 * disappearing — a partially-cleaned document is far better than one with a
 * silent hole in the middle.
 */
export async function cleanupExtractedText(
  text: string,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  const chunks = chunkText(text);

  if (chunks.length === 0) return '';

  console.log(`[Cleanup] ${text.length} chars -> ${chunks.length} chunk(s), model=${CLEANUP_MODEL}`);

  const cleaned: string[] = [];
  let failures = 0;
  let firstFailure: Error | null = null;

  for (let i = 0; i < chunks.length; i++) {
    try {
      const out = await cleanupChunk(chunks[i]);
      const rejected = out.length > 0 ? rejectReason(out, chunks[i]) : 'empty output';
      if (rejected) {
        console.warn(`[Cleanup] chunk ${i + 1}/${chunks.length} rejected (${rejected}), keeping raw text`);
        cleaned.push(chunks[i]);
      } else {
        cleaned.push(out);
        console.log(`[Cleanup] chunk ${i + 1}/${chunks.length}: ${chunks[i].length} -> ${out.length} chars`);
      }
    } catch (e) {
      failures++;
      if (!firstFailure) firstFailure = e instanceof Error ? e : new Error(String(e));
      console.error(`[Cleanup] chunk ${i + 1}/${chunks.length} failed, keeping raw text:`, e);
      cleaned.push(chunks[i]);
    }

    onProgress?.(i + 1, chunks.length);
  }

  // Every chunk failing means the backend is unreachable or the model is
  // missing. Returning the raw text unchanged would look like "cleanup ran and
  // found nothing to fix", so surface the real reason instead.
  // Counted, not inferred by comparing output to input: a model that correctly
  // returns an already-clean chunk unchanged is indistinguishable from a failed
  // one by content alone, so the old check both fired on successful runs and
  // stayed silent when some chunks failed and others came back empty.
  if (firstFailure && failures === chunks.length) {
    throw firstFailure;
  }

  return cleaned.join('\n\n').trim();
}
