/**
 * Frame deduplication via perceptual average-hash (aHash).
 *
 * Each frame is resized to HASH_SIZE×HASH_SIZE grayscale in a Canvas, the mean
 * pixel value is computed, and a 1-bit-per-pixel hash is built (1 if the pixel
 * is >= the mean, 0 otherwise). Consecutive frames whose hash differs by fewer
 * than HAMMING_THRESHOLD bits are considered near-duplicates and dropped.
 *
 * Comparison is always against the last *kept* frame, not the immediately prior
 * one — this prevents slow content drift where many sub-threshold changes
 * accumulate and silently skip real page transitions.
 */

const HASH_SIZE = 16; // 16×16 → 256-bit hash
// 5 % of 256 pixels ≈ 13 bits. Frames with a distance below this are duplicates.
const HAMMING_THRESHOLD = Math.round(HASH_SIZE * HASH_SIZE * 0.05);

/** Read a frame PNG and return a data-URL for use with HTMLImageElement. */
async function toDataUrl(path: string): Promise<string> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(path);
  // Build base64 in chunks to avoid stack-overflow on large frames.
  const chunkSize = 8192;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/** Compute an aHash (average hash) for the image at the given path. */
async function computeAHash(path: string): Promise<Uint8Array> {
  const dataUrl = await toDataUrl(path);

  return new Promise<Uint8Array>((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = HASH_SIZE;
      canvas.height = HASH_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Could not get 2D canvas context')); return; }

      // Bilinear downsample to HASH_SIZE × HASH_SIZE
      ctx.drawImage(img, 0, 0, HASH_SIZE, HASH_SIZE);
      const { data } = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE);

      // Grayscale via luma coefficients
      const grays = new Float32Array(HASH_SIZE * HASH_SIZE);
      let sum = 0;
      for (let i = 0; i < grays.length; i++) {
        const base = i * 4;
        const luma = 0.299 * data[base] + 0.587 * data[base + 1] + 0.114 * data[base + 2];
        grays[i] = luma;
        sum += luma;
      }

      const avg = sum / grays.length;

      // 1 if pixel brightness >= average, else 0
      const hash = new Uint8Array(grays.length);
      for (let i = 0; i < grays.length; i++) {
        hash[i] = grays[i] >= avg ? 1 : 0;
      }

      resolve(hash);
    };

    img.onerror = () => reject(new Error(`Failed to load image: ${path}`));
    img.src = dataUrl;
  });
}

/** Hamming distance between two equal-length bit arrays. */
function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) d++;
  }
  return d;
}

/**
 * Return the subset of `framePaths` that should proceed to OCR, dropping
 * frames that are perceptually near-identical to the last kept frame.
 */
export async function dedupeFrames(framePaths: string[]): Promise<string[]> {
  if (framePaths.length === 0) return [];

  const kept: string[] = [framePaths[0]];
  let lastHash = await computeAHash(framePaths[0]);

  for (let i = 1; i < framePaths.length; i++) {
    let hash: Uint8Array;
    try {
      hash = await computeAHash(framePaths[i]);
    } catch (e) {
      // If we can't hash a frame, keep it to be safe — OCR can still try.
      console.warn(`[Dedup] frame ${i + 1}/${framePaths.length}: hash failed, keeping:`, e);
      kept.push(framePaths[i]);
      continue;
    }

    const dist = hammingDistance(hash, lastHash);
    const isDuplicate = dist < HAMMING_THRESHOLD;

    console.log(
      `[Dedup] frame ${i + 1}/${framePaths.length}: ` +
      `hamming ${dist}/${HASH_SIZE * HASH_SIZE} — ${isDuplicate ? 'SKIP (duplicate)' : 'keep'}`
    );

    if (!isDuplicate) {
      kept.push(framePaths[i]);
      lastHash = hash;
    }
  }

  return kept;
}
