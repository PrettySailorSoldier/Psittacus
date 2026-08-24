import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Crop, Check, SkipForward, RotateCcw } from 'lucide-react';
import styles from './CropSelector.module.css';
import { CropRegion, clampRegion } from '../../lib/cropFrames';

/** Which part of the rectangle a drag is currently manipulating. */
type DragMode =
  | { kind: 'draw'; originX: number; originY: number }
  | { kind: 'move'; grabX: number; grabY: number; start: CropRegion }
  | { kind: 'resize'; handle: Handle; start: CropRegion };

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Smallest rectangle worth OCR'ing, in native pixels. */
const MIN_SIZE = 16;

interface CropSelectorProps {
  /** Path of the frame shown as the drag reference (the first deduped frame). */
  framePath: string;
  /** Region restored from the previous run, if any. */
  initialRegion: CropRegion | null;
  /** Number of frames the confirmed crop will be applied to - shown as context. */
  frameCount: number;
  onConfirm: (region: CropRegion) => void;
  onSkip: () => void;
}

/** Read a frame off disk as a data-URL suitable for an img src. */
async function frameToDataUrl(path: string): Promise<string> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(path);
  const chunkSize = 8192;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/** Build a normalised region from two corner points (either drag direction). */
function regionFromPoints(ax: number, ay: number, bx: number, by: number): CropRegion {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

export default function CropSelector({
  framePath,
  initialRegion,
  frameCount,
  onConfirm,
  onSkip,
}: CropSelectorProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Intrinsic frame resolution - the coordinate space `region` lives in. */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  /** On-screen size of the img element, used only to scale between spaces. */
  const [displayed, setDisplayed] = useState<{ w: number; h: number } | null>(null);

  /**
   * The crop rectangle, always stored in NATIVE frame pixels. Keeping native
   * (rather than CSS) coordinates in state means a window resize rescales the
   * drawn box instead of corrupting the region it represents.
   */
  const [region, setRegion] = useState<CropRegion | null>(initialRegion);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragMode | null>(null);

  // -- Load the reference frame ----------------------------------------------
  useEffect(() => {
    let cancelled = false;
    frameToDataUrl(framePath)
      .then(url => { if (!cancelled) setDataUrl(url); })
      .catch(e => {
        console.error('[Crop] failed to load preview frame:', e);
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [framePath]);

  // -- Track the displayed size so CSS->native scaling stays correct ---------
  useLayoutEffect(() => {
    const el = imgRef.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setDisplayed({ w: r.width, h: r.height });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dataUrl]);

  /** Native pixels per CSS pixel. 1 until the image has been measured. */
  const scale = natural && displayed && displayed.w > 0 ? natural.w / displayed.w : 1;

  /** Convert a pointer event's viewport coords into native frame coords. */
  const toNative = useCallback((clientX: number, clientY: number) => {
    const el = imgRef.current;
    if (!el || !natural) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    // Clamp into the frame so a drag that leaves the image still produces a
    // valid in-bounds rectangle rather than negative or oversized coordinates.
    return {
      x: Math.max(0, Math.min(natural.w, (clientX - r.left) * (natural.w / r.width))),
      y: Math.max(0, Math.min(natural.h, (clientY - r.top) * (natural.h / r.height))),
    };
  }, [natural]);

  // -- Drag handling ---------------------------------------------------------

  const handlePointerDown = (e: React.PointerEvent, mode: 'surface' | 'body' | Handle) => {
    if (!natural) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);

    const p = toNative(e.clientX, e.clientY);

    if (mode === 'surface') {
      // Starting a fresh rectangle discards the old one.
      dragRef.current = { kind: 'draw', originX: p.x, originY: p.y };
      setRegion({ x: p.x, y: p.y, width: 0, height: 0 });
    } else if (mode === 'body') {
      if (!region) return;
      dragRef.current = { kind: 'move', grabX: p.x, grabY: p.y, start: region };
    } else {
      if (!region) return;
      dragRef.current = { kind: 'resize', handle: mode, start: region };
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !natural) return;
    e.preventDefault();

    const p = toNative(e.clientX, e.clientY);

    if (drag.kind === 'draw') {
      setRegion(regionFromPoints(drag.originX, drag.originY, p.x, p.y));
      return;
    }

    if (drag.kind === 'move') {
      const s = drag.start;
      // Offset by the grab point, then clamp so the box stays fully in frame
      // without changing size (plain clamping would squash it at the edges).
      const nx = Math.max(0, Math.min(natural.w - s.width, s.x + (p.x - drag.grabX)));
      const ny = Math.max(0, Math.min(natural.h - s.height, s.y + (p.y - drag.grabY)));
      setRegion({ ...s, x: nx, y: ny });
      return;
    }

    // Resize: move only the edges the grabbed handle owns, then re-normalise so
    // dragging an edge past its opposite flips the rect instead of inverting it.
    const s = drag.start;
    let left = s.x;
    let top = s.y;
    let right = s.x + s.width;
    let bottom = s.y + s.height;

    if (drag.handle.includes('w')) left = p.x;
    if (drag.handle.includes('e')) right = p.x;
    if (drag.handle.includes('n')) top = p.y;
    if (drag.handle.includes('s')) bottom = p.y;

    setRegion(regionFromPoints(left, top, right, bottom));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture was already released - nothing to undo.
    }

    // Snap to whole pixels and drop accidental click-sized rectangles.
    setRegion(prev => {
      if (!prev || !natural) return prev;
      if (prev.width < MIN_SIZE || prev.height < MIN_SIZE) return null;
      return clampRegion(prev, natural.w, natural.h);
    });
  };

  // -- Render ----------------------------------------------------------------

  const isUsable = !!region && region.width >= MIN_SIZE && region.height >= MIN_SIZE;

  /** The region expressed in CSS pixels for drawing the overlay box. */
  const box = region
    ? {
        left: region.x / scale,
        top: region.y / scale,
        width: region.width / scale,
        height: region.height / scale,
      }
    : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.title}>
          <Crop size={16} /> Select the page area
        </div>
        <div className={styles.subtitle}>
          Drag a rectangle around the page content only - leave out the sidebar,
          page-turn arrows and any other reader chrome. Applies to all {frameCount} frames.
        </div>
      </div>

      <div className={styles.stage}>
        {loadError && (
          <div className={styles.error}>
            Could not load the preview frame: {loadError}
            <br />You can still skip the crop and OCR the full frames.
          </div>
        )}

        {!dataUrl && !loadError && <div className={styles.loading}>Loading preview...</div>}

        {dataUrl && (
          <div className={styles.imageWrap}>
            <img
              ref={imgRef}
              className={styles.image}
              src={dataUrl}
              alt="First frame of the recording"
              draggable={false}
              onLoad={e => {
                const el = e.currentTarget;
                setNatural({ w: el.naturalWidth, h: el.naturalHeight });
              }}
            />

            {/* Drag surface sits exactly over the image; starting a drag here
                begins a new rectangle. */}
            <div
              className={styles.surface}
              onPointerDown={e => handlePointerDown(e, 'surface')}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />

            {box && (
              <div
                className={styles.selection}
                style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                onPointerDown={e => handlePointerDown(e, 'body')}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                {HANDLES.map(h => (
                  <div
                    key={h}
                    className={`${styles.handle} ${styles[`handle_${h}`]}`}
                    onPointerDown={e => handlePointerDown(e, h)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.readout}>
        {natural && (
          <span className={styles.dim}>frame {natural.w}x{natural.h}</span>
        )}
        {region ? (
          <span>
            crop {Math.round(region.width)}x{Math.round(region.height)} at (
            {Math.round(region.x)}, {Math.round(region.y)}) px
          </span>
        ) : (
          <span className={styles.dim}>no region selected</span>
        )}
      </div>

      <div className={styles.actionBar}>
        <button className={styles.ghostBtn} onClick={onSkip}>
          <SkipForward size={16} /> Skip crop (use full frame)
        </button>

        <div className={styles.rightActions}>
          <button
            className={styles.ghostBtn}
            onClick={() => setRegion(null)}
            disabled={!region}
          >
            <RotateCcw size={16} /> Clear
          </button>

          <button
            className={styles.primaryBtn}
            onClick={() => region && natural && onConfirm(clampRegion(region, natural.w, natural.h))}
            disabled={!isUsable}
          >
            <Check size={16} /> Confirm crop
          </button>
        </div>
      </div>
    </div>
  );
}
