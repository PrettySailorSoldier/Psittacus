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
