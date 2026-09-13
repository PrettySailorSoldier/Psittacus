
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

export function deduplicateText(frames: string[], threshold: number): string {
  if (frames.length === 0) return '';

  const uniqueFrames: string[] = [];
  
  for (const currentFrame of frames) {
    // If it's too short or empty, just skip it to avoid clutter
    if (currentFrame.trim().length < 3) continue;

    if (uniqueFrames.length === 0) {
      uniqueFrames.push(currentFrame);
      continue;
    }

    const previousFrame = uniqueFrames[uniqueFrames.length - 1];
    
    // Compare current with previous kept frame
    const sim = wordSimilarity(currentFrame, previousFrame);
    
    if (sim < threshold) {
      // It's different enough, keep it
      uniqueFrames.push(currentFrame);
    }
  }

  return uniqueFrames.join('\n\n---\n\n');
}
