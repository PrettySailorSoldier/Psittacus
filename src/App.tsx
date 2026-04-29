import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { tempDir, join } from '@tauri-apps/api/path';
import { mkdir, remove } from '@tauri-apps/plugin-fs';


import TitleBar from './components/TitleBar/TitleBar';
import DropZone from './components/DropZone/DropZone';
import ControlPanel from './components/ControlPanel/ControlPanel';
import ProgressView from './components/ProgressView/ProgressView';
import OutputView from './components/OutputView/OutputView';

import { Settings, loadSettings, saveSettings } from './store/settings';
import { getVideoDuration, extractFrames } from './lib/ffmpeg';
import { runOcrPipeline } from './lib/ocr';

export type AppState = 'idle' | 'ready' | 'processing' | 'done';

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

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const handleSettingsChange = (newSettings: Settings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  };

  const processFile = async (filePath: string) => {
    console.log('[processFile] called with:', filePath);
    try {
      // Basic validation based on extension
      const validExts = ['.mp4', '.mov', '.mkv', '.webm', '.avi'];
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      if (!validExts.includes(ext)) {
        alert('Unsupported file type. Please use mp4, mov, mkv, webm, or avi.');
        return;
      }

      const name = filePath.split(/[\\/]/).pop() || 'Unknown File';

      console.log('[processFile] calling getVideoDuration...');
      const duration = await getVideoDuration(filePath);
      console.log('[processFile] duration:', duration);
      
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
    console.log('[handleManualOpen] opening dialog');
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Video',
          extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi']
        }]
      });
      console.log('[handleManualOpen] selected:', selected, 'type:', typeof selected);
      if (typeof selected === 'string') {
        processFile(selected);
      } else if (selected !== null) {
        // In some plugin-dialog RC versions, the path is nested
        const path = (selected as any)?.path ?? (Array.isArray(selected) ? selected[0] : null);
        console.log('[handleManualOpen] extracted path:', path);
        if (path) processFile(path);
      }
    } catch (e) {
      console.error('[handleManualOpen] error:', e);
    }
  };

  const handleRun = async () => {
    if (!file || !settings) return;
    
    setAppState('processing');
    
    try {
      const estimatedTotal = Math.ceil(file.duration / settings.sampleInterval);
      setProgress({ current: 0, total: estimatedTotal, lastSnippet: 'Extracting frames...' });

      // Create a unique temp directory
      const tempPath = await tempDir();
      const runId = Date.now().toString();
      const frameDir = await join(tempPath, `psittacus_run_${runId}`);
      await mkdir(frameDir, { recursive: true });

      // 1. Extract frames
      const framePaths = await extractFrames(file.path, frameDir, settings.sampleInterval);
      
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

    } catch (error) {
      console.error(error);
      alert('An error occurred during processing.');
      setAppState('ready');
    }
  };

  const handleReset = () => {
    setFile(null);
    setOutput(null);
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
