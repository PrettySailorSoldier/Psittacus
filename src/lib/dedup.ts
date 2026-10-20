
// Single-word Jaccard was tried first but over-fires on real documents: two
// different pages of the same book/article draw from the same small pool of
// common and domain words, so their unique-word sets overlap 85%+ even when
// every sentence differs. Once one page gets misjudged as a duplicate it drops
// out, and — since comparisons anchor on the last *kept* frame, not the raw
// previous one (see below) — every later page keeps getting compared against
// that same first page, so a consistently-reused vocabulary can cascade into
// dropping the entire rest of the document.
//
// Shingling (comparing runs of N consecutive words instead of lone words) is
// the standard fix for this class of false positive: it only counts a match
// when the *same phrase* recurs, not just the same words in any order. Two
// different pages rarely share a run of 3 words verbatim; a genuinely
// duplicated/static frame still matches almost all of its shingles.
const SHINGLE_SIZE = 3;

function shingles(text: string, n: number): Set<string> {
  const words = text.toLowerCase().match(/\w+/g) || [];
  if (words.length === 0) return new Set();
  // Too short to form an n-gram — fall back to treating the whole thing as
  // one unit rather than returning nothing (which would force similarity to 0
  // no matter how alike two short frames are).
  if (words.length < n) return new Set([words.join(' ')]);

  const result = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    result.add(words.slice(i, i + n).join(' '));
  }
  return result;
}

function wordSimilarity(a: string, b: string): number {
  const shinglesA = shingles(a, SHINGLE_SIZE);
  const shinglesB = shingles(b, SHINGLE_SIZE);

  if (shinglesA.size === 0 && shinglesB.size === 0) return 1;
  if (shinglesA.size === 0 || shinglesB.size === 0) return 0;

  let intersectionSize = 0;
  for (const shingle of shinglesA) {
    if (shinglesB.has(shingle)) {
      intersectionSize++;
    }
  }

  const unionSize = shinglesA.size + shinglesB.size - intersectionSize;
  return intersectionSize / unionSize;
}

// ── Overlap stitching ────────────────────────────────────────────────────────
//
// WHY: a scrolling recording does not produce duplicate frames, it produces
// overlapping ones. Each frame repeats the bottom half or so of the one before
// and adds a few new lines. Keeping or dropping whole frames cannot handle
// that: an overlap of 50–70% is below any useful duplicate threshold, so every
// frame was kept whole and each passage appeared two or three times.
//
// Instead, each frame is aligned against the end of the text so far and only
// what comes after the overlap is appended. Where the two readings of the
// overlap differ, the one with fewer misread words is kept — on a real run the
// same line read `"dit the George's` in one frame and `Edit the George's` in
// the next.

/** Fewest matching shingles that establish an overlap. */
const MIN_ANCHORS = 2;

/**
 * Words the text so far may run past the last matched shingle and still be
 * treated as overlapping. Covers a garbled bottom line the next frame reads
 * properly; those trailing words are replaced by the frame's reading.
 */
const END_SLACK = 25;

/** How far a matched shingle may drift off the main alignment, in words. */
const DIAGONAL_SLACK = 2;

/** Share of a frame's shingles found in the recent text that marks it as a repeat. */
const CONTAINED_SHARE = 0.8;

interface Token {
  norm: string;
  start: number;
  end: number;
}

/**
 * Whitespace-separated tokens and their character offsets, normalised for
 * matching. Pure markup ("##", "-", "|", ">") has no letters or digits and is
 * skipped, so it neither matches nor blocks a match, but it stays in place in
 * the text the offsets point into.
 */
function tokenize(text: string, offset = 0): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const norm = m[0].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (norm) tokens.push({ norm, start: offset + m.index!, end: offset + m.index! + m[0].length });
  }
  return tokens;
}

function shingleKey(tokens: Token[], i: number): string {
  return tokens.slice(i, i + SHINGLE_SIZE).map(t => t.norm).join(' ');
}

/** Tokens of `tokens[from..to]` (inclusive) that are neither words nor numbers. */
function unknownCount(tokens: Token[], from: number, to: number, isWord: (w: string) => boolean): number {
  let n = 0;
  for (let i = from; i <= to; i++) {
    const t = tokens[i].norm;
    if (!/\d/.test(t) && !isWord(t)) n++;
  }
  return n;
}

/**
 * Append `frame` to `text`, merging the part they share, or return null if
 * the frame does not continue on from the end of the text.
 */
function mergeOverlap(
  text: string,
  frame: string,
  isWord?: (word: string) => boolean
): string | null {
  // Only the tail of the text can overlap the next frame; tokenising all of
  // it on every frame would make a long run quadratic.
  const tailStart = Math.max(0, text.length - (frame.length * 3 + 2000));
  const a = tokenize(text.slice(tailStart), tailStart);
  const b = tokenize(frame);
  if (a.length < SHINGLE_SIZE || b.length < SHINGLE_SIZE) return null;

  const index = new Map<string, number[]>();
  for (let i = 0; i <= a.length - SHINGLE_SIZE; i++) {
    const key = shingleKey(a, i);
    const list = index.get(key) ?? [];
    list.push(i);
    index.set(key, list);
  }

  const matches: { ai: number; bi: number }[] = [];
  for (let j = 0; j <= b.length - SHINGLE_SIZE; j++) {
    for (const ai of index.get(shingleKey(b, j)) ?? []) matches.push({ ai, bi: j });
  }
  if (matches.length === 0) return null;

  // The overlap is one alignment of frame onto text. Phrases that recur
  // ("due in 15 days") match at other alignments too; the main one is the
  // alignment most matches agree on.
  let bestShift = 0;
  let bestScore = 0;
  for (const { ai, bi } of matches) {
    const shift = ai - bi;
    const score = matches.filter(m => Math.abs(m.ai - m.bi - shift) <= DIAGONAL_SLACK).length;
    if (score > bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }
  if (bestScore < MIN_ANCHORS) return null;

  const aligned = matches
    .filter(m => Math.abs(m.ai - m.bi - bestShift) <= DIAGONAL_SLACK)
    .sort((x, y) => x.bi - y.bi);
  const first = aligned[0];
  const last = aligned[aligned.length - 1];

  // The overlap must reach the end of the text. If it stops well short, the
  // frame repeats something earlier (a scroll back up) rather than continuing.
  if (last.ai + SHINGLE_SIZE < a.length - END_SLACK) return null;

  const aEnd = last.ai + SHINGLE_SIZE - 1;
  const bEnd = last.bi + SHINGLE_SIZE - 1;

  // Take the frame's reading of the overlap when it holds fewer misread
  // words. Both cuts fall at the start of the same matched word, so whatever
  // markup precedes it in the text is kept.
  if (isWord &&
      unknownCount(b, first.bi, bEnd, isWord) < unknownCount(a, first.ai, a.length - 1, isWord)) {
    return text.slice(0, a[first.ai].start) + frame.slice(b[first.bi].start);
  }
  return text.slice(0, a[aEnd].end) + frame.slice(b[bEnd].end);
}

/** Whether most of `frame` already appears in the recent part of `text`. */
function isContained(text: string, frame: string): boolean {
  const frameShingles = shingles(frame, SHINGLE_SIZE);
  if (frameShingles.size === 0) return true;
  const recent = shingles(text.slice(-(frame.length * 4 + 2000)), SHINGLE_SIZE);
  let found = 0;
  for (const s of frameShingles) if (recent.has(s)) found++;
  return found / frameShingles.size >= CONTAINED_SHARE;
}

/**
 * Join per-frame text into one transcript.
 *
 * A frame that continues the text (a scroll) is merged at the overlap. A frame
 * that repeats recent text, or is at least `threshold` similar to the previous
 * frame, is dropped. Anything else (a page turn) is appended after a `---`
 * separator, as before.
 *
 * `isWord` lets the overlap keep whichever frame read it better; without it
 * the earlier reading is kept.
 */
export function stitchFrames(
  frames: string[],
  threshold: number,
  isWord?: (word: string) => boolean
): string {
  let text = '';
  let previousFrame = '';

  for (const raw of frames) {
    const frame = raw.trim();
    // If it's too short or empty, just skip it to avoid clutter
    if (frame.length < 3) continue;

    if (!text) {
      text = frame;
      previousFrame = frame;
      continue;
    }

    const merged = mergeOverlap(text, frame, isWord);
    if (merged !== null) {
      text = merged;
    } else if (wordSimilarity(frame, previousFrame) >= threshold || isContained(text, frame)) {
      continue;
    } else {
      text += `\n\n---\n\n${frame}`;
    }
    previousFrame = frame;
  }

  return text;
}
