// Simple character-level Jaccard similarity between two strings
function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));

  let intersectionSize = 0;
  for (const char of setA) {
    if (setB.has(char)) {
      intersectionSize++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

// Another similarity metric could be word-based, but character-based is robust for OCR noise.
// A more advanced approach uses Levenshtein distance, but Jaccard is faster for a quick check.
// Let's implement a word-based Jaccard which is often better for actual text:
function wordSimilarity(a: string, b: string): number {
  const wordsA = a.toLowerCase().match(/\w+/g) || [];
  const wordsB = b.toLowerCase().match(/\w+/g) || [];

  if (wordsA.length === 0 && wordsB.length === 0) return 1;
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  let intersectionSize = 0;
  for (const word of setA) {
    if (setB.has(word)) {
      intersectionSize++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
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
