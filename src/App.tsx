import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { tempDir, join } from '@tauri-apps/api/path';
import { mkdir, remove } from '@tauri-apps/plugin-fs';


import TitleBar from './components/TitleBar/TitleBar';
import DropZone from './components/DropZone/DropZone';
import RecordButton from './components/RecordButton/RecordButton';
import ControlPanel from './components/ControlPanel/ControlPanel';
import ProgressView from './components/ProgressView/ProgressView';
import OutputView from './components/OutputView/OutputView';

import { Settings, loadSettings, saveSettings } from './store/settings';
import { getVideoDuration, extractFrames } from './lib/ffmpeg';
import { runOcrPipeline } from './lib/ocr';

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
  // Path of the current screen recording, if the loaded file came from one.
  // Tracked so it can be cleaned up after a successful run.
  const [recordingPath, setRecordingPath] = useState<string | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const handleSettingsChange = (newSettings: Settings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  const processFile = async (filePath: string) => {
    try {
      const validExts = ['.mp4', '.mov', '.mkv', '.webm', '.avi'];
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      if (!validExts.includes(ext)) {
        alert('Unsupported file type. Please use mp4, mov, mkv, webm, or avi.');
        return;
      }

      const name = filePath.split(/[\\/]/).pop() || 'Unknown File';
      const duration = await getVideoDuration(filePath);
      
      setFile({
        path: filePath,
        name,
        size: 'Unknown Size', // Could be added via fs metadata if needed
        duration
      });
      setAppState('ready');
    } catch (e) {
      console.error('processFile error:', e);
      const msg = e instanceof Error ? e.message : String(e);
      setAppState('idle');
      // Use Tauri dialog for errors so it appears on top of the frameless window
      import('@tauri-apps/plugin-dialog').then(({ message }) =>
        message(`Failed to load video:\n${msg}`, { title: 'Error', kind: 'error' })
      );
    }
  };

  useEffect(() => {
    const unlisten = listen('tauri://drag-drop', (event) => {
      const payload = event.payload as { paths: string[] };
      if (payload.paths && payload.paths.length > 0) {
        processFile(payload.paths[0]);
      }
    });

    return () => {
      unlisten.then(f => f());
    };
  }, []);

  const handleManualOpen = async () => {
    const selected = await open({
      multiple: false,
      filters: [{
        name: 'Video',
        extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi']
      }]
    });
    if (typeof selected === 'string') {
      processFile(selected);
    } else if (selected !== null) {
      const path = (selected as any)?.path ?? (Array.isArray(selected) ? selected[0] : null);
      if (path) processFile(path);
    }
  };

  // The pipeline itself is identical for imported and recorded video. Only the
  // origin differs, and that determines whether the source file is a temporary
  // recording we should clean up afterwards.
  const runPipeline = async (target: FileInfo, isTempRecording = false) => {
    if (!settings) return;

    setAppState('processing');

    try {
      const estimatedTotal = Math.ceil(target.duration / settings.sampleInterval);
      setProgress({ current: 0, total: estimatedTotal, lastSnippet: 'Extracting frames...' });

      // Create a unique temp directory
      const tempPath = await tempDir();
      const runId = Date.now().toString();
      const frameDir = await join(tempPath, `psittacus_run_${runId}`);
      await mkdir(frameDir, { recursive: true });

      // 1. Extract frames
      const framePaths = await extractFrames(target.path, frameDir, settings.sampleInterval);

      setProgress({ current: 0, total: framePaths.length, lastSnippet: 'Starting OCR...' });

      // 2. Run OCR Pipeline
      const finalResult = await runOcrPipeline(
        framePaths,
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

      const wordCount = finalResult.split(/\s+/).filter(Boolean).length;
      const uniqueFrames = finalResult.split('\n\n---\n\n').length;

      setOutput({
        text: finalResult,
        wordCount,
        frameCount: uniqueFrames
      });
      
      setAppState('done');

      // Cleanup
      await remove(frameDir, { recursive: true });

      // A screen recording is a scratch file in the app cache; the OCR text is
      // the deliverable, so drop it once the run has fully succeeded. On
      // failure it is deliberately left in place (see catch) rather than
      // silently discarded.
      if (isTempRecording) {
        try {
          await invoke('discard_recording', { path: target.path });
          setRecordingPath(null);
        } catch (cleanupError) {
          console.warn('Could not remove temporary recording:', cleanupError);
        }
      }

    } catch (error) {
      console.error(error);
      alert('An error occurred during processing.');
      setAppState('ready');
    }
  };

  const handleRun = async () => {
    if (!file) return;
    await runPipeline(file, file.path === recordingPath);
  };

  const showError = (title: string, msg: string) => {
    import('@tauri-apps/plugin-dialog').then(({ message }) =>
      message(msg, { title, kind: 'error' })
    );
  };

  const handleRecordingStart = () => setAppState('recording');

  const handleRecordingStop = async (filePath: string) => {
    try {
      const name = filePath.split(/[\\/]/).pop() || 'Screen Recording';
      const duration = await getVideoDuration(filePath);
      const recorded: FileInfo = {
        path: filePath,
        name,
        size: 'Screen recording',
        duration,
      };

      setRecordingPath(filePath);
      setFile(recorded);

      // Straight into the same extraction + OCR pipeline an import would take.
      await runPipeline(recorded, true);
    } catch (e) {
      console.error('handleRecordingStop error:', e);
      const msg = e instanceof Error ? e.message : String(e);
      setAppState('idle');
      showError('Recording Error', `The recording finished but could not be read:\n${msg}\n\nThe file is still at:\n${filePath}`);
    }
  };

  const handleRecordingError = (msg: string) => {
    setAppState('idle');
    showError('Recording Error', msg);
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
