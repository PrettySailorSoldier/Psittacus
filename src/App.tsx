import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { tempDir, join } from '@tauri-apps/api/path';
import { mkdir, remove } from '@tauri-apps/plugin-fs';

import TitleBar from './components/TitleBar/TitleBar';
import DropZone from './components/DropZone/DropZone';
import ControlPanel from './components/ControlPanel/ControlPanel';
import ProgressView from './components/ProgressView/ProgressView';
import OutputView from './components/OutputView/OutputView';
import RecordButton from './components/RecordButton/RecordButton';
import CropSelector from './components/CropSelector/CropSelector';

import { Settings, loadSettings, saveSettings, loadCropRegion, saveCropRegion } from './store/settings';
import { getVideoDuration, extractFrames } from './lib/ffmpeg';
import { dedupeFrames } from './lib/frameDedup';
import { CropRegion, cropFrames } from './lib/cropFrames';
// runOcrPipeline kept as an unused manual fallback (llava-only mode)
import { runOcrPipeline as _runOcrPipeline, runHybridOcrPipeline } from './lib/ocr';

export type AppState = 'idle' | 'recording' | 'ready' | 'processing' | 'cropping' | 'done';

export interface FileInfo {
  path: string;
  name: string;
  size: string;
  duration: number;
}

export default function App() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [file, setFile] = useState<FileInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, lastSnippet: '' });
  const [output, setOutput] = useState<{
    text: string;
    wordCount: number;
    frameCount: number;
    /** Raw per-frame OCR text, kept so the optional cleanup pass can rerun from source. */
    frameTexts: string[];
  } | null>(null);
  // Path of the cached recording mp4 so we can discard it after processing
  const [recordingPath, setRecordingPath] = useState<string | null>(null);

  // ── Crop step state ────────────────────────────────────────────────────────
  // The crop selector sits in the middle of an async pipeline, so `handleRun`
  // parks on a promise that the Confirm/Skip handlers resolve. `cropResolver`
  // holds that promise's resolve fn; `cropPrompt` holds what the UI needs to
  // render. Keeping the resolver in a ref (not state) avoids re-rendering the
  // selector every time the pipeline touches unrelated state.
  const cropResolver = useRef<((region: CropRegion | null) => void) | null>(null);
  const [cropPrompt, setCropPrompt] = useState<{ framePath: string; frameCount: number } | null>(null);
  // Last-used region, restored from the store so repeat recordings of the same
  // reader window are a single confirm click.
  const [cropRegion, setCropRegion] = useState<CropRegion | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
    loadCropRegion().then(setCropRegion);
  }, []);

  const handleSettingsChange = (newSettings: Settings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  const showError = (msg: string, title = 'Error') =>
    import('@tauri-apps/plugin-dialog').then(({ message }) =>
      message(msg, { title, kind: 'error' })
    );

  const processFile = async (filePath: string) => {
    try {
      const validExts = ['.mp4', '.mov', '.mkv', '.webm', '.avi'];
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      if (!validExts.includes(ext)) {
        showError('Unsupported file type. Please use mp4, mov, mkv, webm, or avi.');
        return;
      }

      const name = filePath.split(/[\\\/]/).pop() || 'Unknown File';
      const duration = await getVideoDuration(filePath);

      setFile({ path: filePath, name, size: 'Unknown Size', duration });
      setAppState('ready');
    } catch (e) {
      console.error('processFile error:', e);
      setAppState('idle');
      showError(`Failed to load video:\n${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => {
    const unlisten = listen('tauri://drag-drop', (event) => {
      const payload = event.payload as { paths: string[] };
      if (payload.paths && payload.paths.length > 0) {
        processFile(payload.paths[0]);
      }
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  const handleManualOpen = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }]
    });
    if (typeof selected === 'string') {
      processFile(selected);
    } else if (selected !== null) {
      const path = (selected as any)?.path ?? (Array.isArray(selected) ? selected[0] : null);
      if (path) processFile(path);
    }
  };

  // ── Screen recording handlers ─────────────────────────────────────────────

  const handleRecordingStart = () => {
    setAppState('recording');
  };

  const handleRecordingStop = async (mp4Path: string) => {
    // Store the path so we can discard the cache file after extraction
    setRecordingPath(mp4Path);
    await processFile(mp4Path);
  };

  const handleRecordingError = (msg: string) => {
    setAppState('idle');
    showError(msg, 'Recording Error');
  };

  // ── Crop step ─────────────────────────────────────────────────────────────

  /**
   * Show the crop selector and wait for the user's decision.
   * Resolves with a region to crop to, or null if they skipped.
   */
  const askForCropRegion = (framePath: string, frameCount: number) =>
    new Promise<CropRegion | null>(resolve => {
      cropResolver.current = resolve;
      setCropPrompt({ framePath, frameCount });
      setAppState('cropping');
    });

  /** Hand the decision back to the parked pipeline and return to the progress view. */
  const finishCropStep = (region: CropRegion | null) => {
    const resolve = cropResolver.current;
    cropResolver.current = null;
    setCropPrompt(null);
    setAppState('processing');
    resolve?.(region);
  };

  // ── Extraction pipeline ───────────────────────────────────────────────────

  const handleRun = async () => {
    if (!file || !settings) return;

    setAppState('processing');

    const estimatedTotal = Math.ceil(file.duration / settings.sampleInterval);
    setProgress({ current: 0, total: estimatedTotal, lastSnippet: 'Extracting frames...' });

    // Create a unique temp directory for this run
    const tempPath = await tempDir();
    const runId = Date.now().toString();
    const frameDir = await join(tempPath, `psittacus_run_${runId}`);
    await mkdir(frameDir, { recursive: true });

    try {
      // 1. Extract frames via ffmpeg
      const framePaths = await extractFrames(file.path, frameDir, settings.sampleInterval);

      // 2. Deduplicate near-identical consecutive frames before OCR
      setProgress({ current: 0, total: framePaths.length, lastSnippet: 'Deduplicating frames...' });
      const dedupedPaths = await dedupeFrames(framePaths);
      console.log(`[OCR] frames extracted: ${framePaths.length}, after dedup: ${dedupedPaths.length}`);

      // 3. Let the user crop away the reader chrome (sidebar, page arrows).
      //    Runs after dedup, not before: cropping doesn't change which frames
      //    are near-duplicates of each other, so doing it here avoids paying
      //    the crop cost on frames that get discarded anyway.
      let ocrPaths = dedupedPaths;
      if (dedupedPaths.length > 0) {
        const region = await askForCropRegion(dedupedPaths[0], dedupedPaths.length);

        if (region) {
          setCropRegion(region);
          saveCropRegion(region); // fire-and-forget: a failed save is not fatal
          setProgress({ current: 0, total: dedupedPaths.length, lastSnippet: 'Cropping frames...' });
          ocrPaths = await cropFrames(dedupedPaths, region, (done, total) => {
            setProgress({ current: done, total, lastSnippet: `Cropping frame ${done}/${total}...` });
          });
        } else {
          console.log('[Crop] skipped — OCR will run on full frames');
        }
      }

      // 4. Run hybrid OCR pipeline (Tesseract primary, llava fallback)
      setProgress({ current: 0, total: ocrPaths.length, lastSnippet: 'Starting OCR...' });
      const finalResult = await runHybridOcrPipeline(
        ocrPaths,
        settings.language,
        settings.dedupeThreshold,
        (frameIndex, text) => {
          setProgress(prev => ({
            ...prev,
            current: frameIndex + 1,
            lastSnippet: text || '(No text found)'
          }));
        }
      );

      const wordCount = finalResult.text.split(/\s+/).filter(Boolean).length;

      setOutput({
        text: finalResult.text,
        wordCount,
        frameCount: finalResult.framesProcessed,
        frameTexts: finalResult.frameTexts,
      });
      setAppState('done');

    } catch (error) {
      console.error(error);
      showError('An error occurred during processing.');
      setAppState('ready');
    } finally {
      // Always clean up temp frames, even on error
      try {
        await remove(frameDir, { recursive: true });
      } catch (e) {
        console.warn('Failed to clean up temp frames:', e);
      }
      // Discard the cached recording mp4 if this run came from a screen recording
      if (recordingPath) {
        try {
          await invoke('discard_recording', { path: recordingPath });
        } catch (e) {
          console.warn('Failed to discard recording:', e);
        }
        setRecordingPath(null);
      }
    }
  };

  const handleReset = () => {
    setFile(null);
    setOutput(null);
    setRecordingPath(null);
    setProgress({ current: 0, total: 0, lastSnippet: '' });
    setAppState('idle');
  };

  if (!settings) {
    return <div style={{ color: 'white', padding: 20 }}>Loading...</div>;
  }

  return (
    <>
      <TitleBar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minHeight: 0, minWidth: 0 }}>

        {(appState === 'idle' || appState === 'ready') && (
          <DropZone
            state={appState}
            file={file}
            onFileDrop={processFile}
            onClick={appState === 'idle' ? handleManualOpen : undefined}
            onClear={handleReset}
          />
        )}

        {(appState === 'idle' || appState === 'recording') && (
          <RecordButton
            isRecording={appState === 'recording'}
            onStart={handleRecordingStart}
            onStop={handleRecordingStop}
            onError={handleRecordingError}
          />
        )}

        {appState === 'ready' && (
          <ControlPanel
            settings={settings}
            onChange={handleSettingsChange}
            onRun={handleRun}
            disabled={false}
            fileDuration={file?.duration || 0}
          />
        )}

        {appState === 'cropping' && cropPrompt && (
          <CropSelector
            framePath={cropPrompt.framePath}
            frameCount={cropPrompt.frameCount}
            initialRegion={cropRegion}
            onConfirm={region => finishCropStep(region)}
            onSkip={() => finishCropStep(null)}
          />
        )}

        {appState === 'processing' && (
          <ProgressView
            current={progress.current}
            total={progress.total}
            lastSnippet={progress.lastSnippet}
          />
        )}

        {appState === 'done' && output && (
          <OutputView
            text={output.text}
            wordCount={output.wordCount}
            frameCount={output.frameCount}
            exportFormat={settings.exportFormat}
            onReset={handleReset}
            rawFrameTexts={output.frameTexts}
          />
        )}
      </div>
    </>
  );
}
