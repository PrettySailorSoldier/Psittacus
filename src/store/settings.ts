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
 * Load the crop region from the previous run, or null if there is none.
 *
 * Most users record the same reader window at the same size over and over, so
 * restoring the last rectangle means the crop step is a single confirm click
 * after the first time.
 */
export async function loadCropRegion(): Promise<CropRegion | null> {
  try {
    const s = await getStore();
    const saved = await s.get<CropRegion>(CROP_REGION_KEY);
    if (
      saved &&
      typeof saved.x === 'number' && typeof saved.y === 'number' &&
      typeof saved.width === 'number' && typeof saved.height === 'number' &&
      saved.width > 0 && saved.height > 0
    ) {
      return saved;
    }
    return null;
  } catch (error) {
    console.error('Failed to load crop region:', error);
    return null;
  }
}

export async function saveCropRegion(region: CropRegion): Promise<void> {
  try {
    const s = await getStore();
    await s.set(CROP_REGION_KEY, region);
    await s.save();
  } catch (error) {
    console.error('Failed to save crop region:', error);
  }
}
