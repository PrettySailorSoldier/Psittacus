import { useState, useEffect } from 'react';
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

import { Settings, loadSettings, saveSettings } from './store/settings';
import { getVideoDuration, extractFrames } from './lib/ffmpeg';
import { dedupeFrames } from './lib/frameDedup';
// runOcrPipeline kept as an unused manual fallback (llava-only mode)
import { runOcrPipeline as _runOcrPipeline, runHybridOcrPipeline } from './lib/ocr';

export type AppState = 'idle' | 'recording' | 'ready' | 'processing' | 'done';

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
  const [output, setOutput] = useState<{ text: string; wordCount: number; frameCount: number } | null>(null);
  // Path of the cached recording mp4 so we can discard it after processing
  const [recordingPath, setRecordingPath] = useState<string | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
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

      // 3. Run hybrid OCR pipeline (Tesseract primary, llava fallback)
      setProgress({ current: 0, total: dedupedPaths.length, lastSnippet: 'Starting OCR...' });
      const finalResult = await runHybridOcrPipeline(
        dedupedPaths,
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>

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
          />
        )}
      </div>
    </>
  );
}
