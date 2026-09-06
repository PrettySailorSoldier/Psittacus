import { load, Store } from '@tauri-apps/plugin-store';
export interface Settings {
  sampleInterval: number;
  language: string;
  dedupeThreshold: number;
  exportFormat: 'txt' | 'md';
}

const DEFAULT_SETTINGS: Settings = {
  sampleInterval: 1,
  language: 'eng',
  dedupeThreshold: 0.85,
  exportFormat: 'txt',
};

// Lazy initialization of the store
let store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await load('psittacus-settings.json');
  }
  return store;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const s = await getStore();
    const saved = await s.get<Settings>('userSettings');
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch (error) {
    console.error('Failed to load settings:', error);
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  try {
    const s = await getStore();
    await s.set('userSettings', settings);
    await s.save();
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

// ── Last-used crop region ────────────────────────────────────────────────────
// Kept out of `Settings` deliberately: it is resolution-dependent state tied to
// whichever reader window was last recorded, not a user preference, and it has
// no sensible default to merge against.

import type { CropRegion } from '../lib/cropFrames';

const CROP_REGION_KEY = 'lastCropRegion';

/**
 * A stored region, tagged with the frame size it was drawn against.
 *
 * The dimensions are not decoration: a rectangle only means anything relative
 * to the frame it was drawn on. Restoring a region from a 3840×4320 two-monitor
 * capture onto a 3840×2160 single-monitor one silently selects the wrong part
 * of the image, and because the crop step invites a single confirm click, that
 * wrong region gets accepted without the user ever redrawing it.
 */
interface StoredCropRegion extends CropRegion {
  frameWidth: number;
  frameHeight: number;
}

/**
 * Load the crop region from the previous run, or null if there is none.
 *
 * Most users record the same reader window at the same size over and over, so
 * restoring the last rectangle means the crop step is a single confirm click
 * after the first time. `frameWidth`/`frameHeight` gate that: a region is only
 * offered back when the new frame is the same size as the one it came from.
 */
export async function loadCropRegion(
  frameWidth: number,
  frameHeight: number
): Promise<CropRegion | null> {
  try {
    const s = await getStore();
    const saved = await s.get<StoredCropRegion>(CROP_REGION_KEY);
    if (
      saved &&
      typeof saved.x === 'number' && typeof saved.y === 'number' &&
      typeof saved.width === 'number' && typeof saved.height === 'number' &&
      saved.width > 0 && saved.height > 0 &&
      // A region with no recorded frame size predates this check and cannot be
      // validated, so it is discarded rather than trusted.
      saved.frameWidth === frameWidth &&
      saved.frameHeight === frameHeight
    ) {
      return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    }
    return null;
  } catch (error) {
    console.error('Failed to load crop region:', error);
    return null;
  }
}

export async function saveCropRegion(
  region: CropRegion,
  frameWidth: number,
  frameHeight: number
): Promise<void> {
  try {
    const s = await getStore();
    await s.set(CROP_REGION_KEY, { ...region, frameWidth, frameHeight });
    await s.save();
  } catch (error) {
    console.error('Failed to save crop region:', error);
  }
}
