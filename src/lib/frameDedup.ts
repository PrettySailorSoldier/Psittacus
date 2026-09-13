/**
 * Frame deduplication by downsampled-image difference.
 *
 * Each frame is reduced to a GRID_SIZE×GRID_SIZE grayscale grid in a Canvas and
 * compared against the last kept frame by mean absolute per-cell difference,
 * normalised to 0–1. Frames below DIFFERENCE_THRESHOLD are near-identical and
 * are dropped before OCR.
 *
 * Comparison is always against the last *kept* frame, not the immediately prior
 * one — this prevents slow content drift where many sub-threshold changes
 * accumulate and silently skip real page transitions.
 *
 * WHY NOT A PERCEPTUAL HASH (aHash/dHash): this stage used a 16×16 average hash
 * with a Hamming threshold, and it dropped real pages. Both 1-bit hashes fail on
 * document frames for the same underlying reason — a page is mostly flat
 * whitespace, so most cells sit near the binarisation boundary and their bit is
 * decided by noise rather than by content:
 *
 *   - aHash thresholds each cell at the frame mean. Two different pages of the
 *     same book produce near-identical hashes, because the hash mostly encodes
 *     "where the text block sits" — which does not change between pages. Two
 *     genuinely different prose pages measured 10–21 bits apart against a
 *     13-bit threshold, i.e. straddling it. Pages were being lost here.
 *   - dHash compares each cell to its right neighbour, so in margins and static
 *     chrome (where neighbours are nearly equal) the bits are coin-flips. Same
 *     page plus mild compression noise measured 42–56 bits apart — overlapping
 *     *different* pages at 39–56. No threshold separates those.
 *
 * Skipping binarisation removes that failure mode: averaging is noise-tolerant,
 * and a real content change moves cell brightness well clear of the noise floor.
 *
 * A false "different" here is cheap — one extra frame through OCR, and the text
 * layer collapses the repeat. A false "duplicate" is unrecoverable page loss, so
 * the threshold is deliberately set to be conservative in that direction.
 */

/** Comparison grid resolution. 32×32 = 1024 cells. */
const GRID_SIZE = 32;

/**
 * Mean per-cell brightness difference (0–1) above which two frames are treated
 * as different content.
 *
 * Measured separation on simulated reader frames, static chrome included:
 *   same page + compression noise   0.0037 – 0.0038
 *   same page + blinking caret      0.0001
 *   DIFFERENT pages                 0.0308 – 0.0389
 *
 * 0.01 sits between them with ~2.6x headroom over the duplicate ceiling and ~3x
 * below the different-page floor.
 *
 * The one case this cannot decide is a *small scroll*: shifting a page by a few
 * lines changes very little of the image, and lands in the same range as noise.
 * That is a limit of comparing whole images, not of this threshold — and it is
 * already handled downstream, where the text dedup drops repeated passages and
 * the optional cleanup pass merges overlapping ones.
 */
const DIFFERENCE_THRESHOLD = 0.01;

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

/**
 * Reduce the image at `path` to a GRID_SIZE×GRID_SIZE grid of grayscale values
 * in the 0–255 range.
 */
async function computeGrid(path: string): Promise<Float32Array> {
  const dataUrl = await toDataUrl(path);

  return new Promise<Float32Array>((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = GRID_SIZE;
      canvas.height = GRID_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Could not get 2D canvas context')); return; }

      // Bilinear downsample to GRID_SIZE × GRID_SIZE
      ctx.drawImage(img, 0, 0, GRID_SIZE, GRID_SIZE);
      const { data } = ctx.getImageData(0, 0, GRID_SIZE, GRID_SIZE);

      // Grayscale via luma coefficients
      const grays = new Float32Array(GRID_SIZE * GRID_SIZE);
      for (let i = 0; i < grays.length; i++) {
        const base = i * 4;
        grays[i] = 0.299 * data[base] + 0.587 * data[base + 1] + 0.114 * data[base + 2];
      }

      resolve(grays);
    };

    img.onerror = () => reject(new Error(`Failed to load image: ${path}`));
    img.src = dataUrl;
  });
}

/**
 * Mean absolute per-cell difference between two grids, normalised to 0–1.
 *
 * Returns 1 (maximally different) for mismatched lengths rather than comparing
 * a prefix — that only happens if the frames differ in size, which is itself a
 * reason to keep the frame.
 */
function gridDifference(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 1;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    total += Math.abs(a[i] - b[i]);
  }
  return total / a.length / 255;
}

/**
 * Return the subset of `framePaths` that should proceed to OCR, dropping
 * frames that are near-identical to the last kept frame.
 */
export async function dedupeFrames(framePaths: string[]): Promise<string[]> {
  if (framePaths.length === 0) return [];

  const kept: string[] = [framePaths[0]];
  let lastGrid: Float32Array | null = null;
  try {
    lastGrid = await computeGrid(framePaths[0]);
  } catch (e) {
    // Without a reference grid nothing can be compared against, so every
    // later frame is kept until one of them produces a usable reference.
    console.warn(`[Dedup] frame 1/${framePaths.length}: grid failed, keeping all until a reference is available:`, e);
  }

  for (let i = 1; i < framePaths.length; i++) {
    let grid: Float32Array;
    try {
      grid = await computeGrid(framePaths[i]);
    } catch (e) {
      // If we can't measure a frame, keep it to be safe — OCR can still try.
      console.warn(`[Dedup] frame ${i + 1}/${framePaths.length}: grid failed, keeping:`, e);
      kept.push(framePaths[i]);
      continue;
    }

    if (lastGrid === null) {
      // No reference yet (the frames before this one could not be measured).
      kept.push(framePaths[i]);
      lastGrid = grid;
      continue;
    }

    const diff = gridDifference(grid, lastGrid);
    const isDuplicate = diff < DIFFERENCE_THRESHOLD;

    console.log(
      `[Dedup] frame ${i + 1}/${framePaths.length}: ` +
      `difference ${diff.toFixed(4)} (threshold ${DIFFERENCE_THRESHOLD}) — ` +
      `${isDuplicate ? 'SKIP (duplicate)' : 'keep'}`
    );

    if (!isDuplicate) {
      kept.push(framePaths[i]);
      lastGrid = grid;
    }
  }

  console.log(`[Dedup] ${framePaths.length} frame(s) in, ${kept.length} kept`);

  return kept;
}
