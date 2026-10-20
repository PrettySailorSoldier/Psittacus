/**
 * Frontend side of auto-capture (`src-tauri/src/auto_capture.rs`).
 *
 * The Rust side drives the browser — scrolls, waits for the page to settle,
 * clicks Next — and saves one settled frame per scroll step, grouped by
 * section. This module only starts and stops it and relays its progress; the
 * frames it returns go through the same OCR pipeline as a recording.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CropRegion } from './cropFrames';

/** Seconds between Start and the first scroll, to focus the browser window. */
export const COUNTDOWN_SECONDS = 5;

export type AutoCapturePhase =
  | 'countdown'
  | 'settling'
  | 'scrolling'
  | 'searching'
  | 'clicking'
  | 'loading'
  | 'done';

export interface AutoCaptureProgress {
  phase: AutoCapturePhase;
  /** Section being captured, from 1; 0 before the first. */
  section: number;
  /** Frames saved so far, across all sections. */
  frames: number;
  message: string;
  countdown: number | null;
}

export interface CapturedSection {
  index: number;
  /** Settled frames, top of the section to bottom. */
  frames: string[];
}

export interface AutoCaptureResult {
  sections: CapturedSection[];
  /** Why the run ended, in words for the user. */
  stopReason: string;
  /** Temp directory holding every frame; delete it once processed. */
  frameDir: string;
}

export interface AutoCaptureOptions {
  /** In the reference frame's pixels; null captures the whole monitor. */
  region: CropRegion | null;
  stepFraction: number;
  maxSections: number;
  nextLabels: string[];
  followArrowLinks: boolean;
  countdownSecs: number;
}

/** Screenshot the monitor auto-capture will use, for the crop step. */
export function captureScreenFrame(): Promise<string> {
  return invoke<string>('capture_screen_frame');
}

export function startAutoCapture(options: AutoCaptureOptions): Promise<AutoCaptureResult> {
  return invoke<AutoCaptureResult>('start_auto_capture', { options });
}

export function stopAutoCapture(): Promise<void> {
  return invoke('stop_auto_capture');
}

export function onAutoCaptureProgress(
  handler: (progress: AutoCaptureProgress) => void
): Promise<UnlistenFn> {
  return listen<AutoCaptureProgress>('auto-capture-progress', e => handler(e.payload));
}
