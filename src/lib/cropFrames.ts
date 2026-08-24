/**
 * Canvas-based frame cropping.
 *
 * Reader recordings capture the whole application window, so every frame
 * carries the same UI chrome (sidebar navigation, page-turn arrows, chapter
 * labels) alongside the actual page. Tesseract reads that chrome on every
 * single frame, which means the identical nav text is appended to the
 * transcript once per frame and survives text dedup because it is interleaved
 * with genuinely different page content.
 *
 * Cropping to the page rectangle removes the problem at the source: the
 * chrome is never rasterised into the image Tesseract sees.
 *
 * This runs entirely in the renderer via `<canvas>` — no new Rust command.
 * Crop is applied to the *deduped* frame list: cropping cannot change which
 * frames are perceptual duplicates of each other in any way that matters, so
 * doing it after dedup avoids cropping frames that get thrown away anyway.
 */

/**
 * A crop rectangle in the frame's **native pixel** coordinate space — i.e.
 * relative to the PNG's intrinsic width/height, not the on-screen preview
 * size. `CropSelector` converts from CSS pixels before emitting this.
 */
export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Read an image file from disk and return a data-URL for `HTMLImageElement`. */
async function toDataUrl(path: string): Promise<string> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(path);
  // Chunked base64: String.fromCharCode(...) on a multi-MB frame blows the
  // argument limit and throws a RangeError.
  const chunkSize = 8192;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/** Decode an image path into a loaded `HTMLImageElement`. */
function loadImage(dataUrl: string, path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to decode image: ${path}`));
    img.src = dataUrl;
  });
}

/** Promise wrapper around `canvas.toBlob` (which is callback-only). */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
      'image/png'
    );
  });
}

/**
 * Clamp a region to the bounds of a `width` × `height` image.
 *
 * A region saved against a 1920×1080 recording is meaningless against a
 * 1280×720 one, and an out-of-bounds `drawImage` source rect silently yields
 * transparent pixels rather than throwing — which would look like "OCR found
 * nothing" instead of "the crop was wrong". Clamping keeps a stale region
 * merely imprecise rather than catastrophic.
 */
export function clampRegion(region: CropRegion, width: number, height: number): CropRegion {
  const x = Math.max(0, Math.min(Math.round(region.x), width - 1));
  const y = Math.max(0, Math.min(Math.round(region.y), height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(region.width), width - x)),
    height: Math.max(1, Math.min(Math.round(region.height), height - y)),
  };
}

/** Build the output path for a cropped frame, alongside its source. */
function croppedPathFor(framePath: string): string {
  const sep = framePath.includes('\\') ? '\\' : '/';
  const idx = Math.max(framePath.lastIndexOf('\\'), framePath.lastIndexOf('/'));
  const dir = idx >= 0 ? framePath.slice(0, idx) : '.';
  const name = idx >= 0 ? framePath.slice(idx + 1) : framePath;
  return `${dir}${sep}cropped_${name}`;
}

/**
 * Crop a single frame to `region` and write the result next to the source as
 * `cropped_<name>.png`. Returns the path of the new file.
 *
 * `region` is interpreted in the source image's native pixel coordinates and
 * is clamped to its bounds before use.
 */
export async function cropFrame(framePath: string, region: CropRegion): Promise<string> {
  const img = await loadImage(await toDataUrl(framePath), framePath);

  const r = clampRegion(region, img.naturalWidth, img.naturalHeight);

  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D canvas context');

  // Source rect (r) → destination rect filling the canvas 1:1, so the crop is
  // a straight pixel copy with no resampling.
  ctx.drawImage(img, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);

  const blob = await canvasToBlob(canvas);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const outPath = croppedPathFor(framePath);
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(outPath, bytes);

  return outPath;
}

/**
 * Crop every frame in `framePaths`, returning the cropped paths in the same
 * order.
 *
 * A frame that fails to crop falls back to its original path rather than
 * dropping out of the run — a bit of leftover UI chrome on one frame beats
 * losing that page's text entirely.
 */
export async function cropFrames(
  framePaths: string[],
  region: CropRegion,
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  const out: string[] = [];

  for (let i = 0; i < framePaths.length; i++) {
    try {
      out.push(await cropFrame(framePaths[i], region));
    } catch (e) {
      console.warn(`[Crop] frame ${i + 1}/${framePaths.length}: crop failed, using original:`, e);
      out.push(framePaths[i]);
    }
    onProgress?.(i + 1, framePaths.length);
  }

  console.log(
    `[Crop] cropped ${out.length} frame(s) to ` +
    `${region.width}×${region.height} at (${region.x}, ${region.y})`
  );

  return out;
}
