import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Circle, Square } from 'lucide-react';
import styles from './RecordButton.module.css';

interface RecordButtonProps {
  /** Owned by App's state machine, so the button stays in sync with appState. */
  isRecording: boolean;
  /** Called once ffmpeg has actually spawned. */
  onStart: () => void;
  /** Called with the finished mp4 path once ffmpeg has cleanly finalized it. */
  onStop: (filePath: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function RecordButton({
  isRecording,
  onStart,
  onStop,
  onError,
  disabled = false,
}: RecordButtonProps) {
  const [elapsed, setElapsed] = useState(0);
  // ffmpeg needs a moment to flush the moov atom after being asked to quit,
  // so the button reports that wait rather than looking hung.
  const [isStopping, setIsStopping] = useState(false);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!isRecording) {
      startedAt.current = null;
      setElapsed(0);
      return;
    }

    startedAt.current = Date.now();
    setElapsed(0);
    // Derive from a timestamp rather than counting ticks, so the timer stays
    // accurate if the interval drifts.
    const id = setInterval(() => {
      if (startedAt.current !== null) {
        setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
      }
    }, 500);

    return () => clearInterval(id);
  }, [isRecording]);

  const handleStart = async () => {
    try {
      // window_target omitted -> full desktop capture.
      await invoke('start_recording', { windowTarget: null });
      onStart();
    } catch (e) {
      onError(typeof e === 'string' ? e : String(e));
    }
  };

  const handleStop = async () => {
    setIsStopping(true);
    try {
      const filePath = await invoke<string>('stop_recording');
      onStop(filePath);
    } catch (e) {
      onError(typeof e === 'string' ? e : String(e));
    } finally {
      setIsStopping(false);
    }
  };

  if (!isRecording) {
    return (
      <div className={styles.container}>
        <button
          className={styles.startButton}
          onClick={handleStart}
          disabled={disabled}
        >
          <Circle size={12} fill="currentColor" strokeWidth={0} />
          Record Screen
        </button>
        <p className={styles.hint}>Capture your screen, then run the same OCR pass</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.liveRow}>
        <span className={styles.pulse} />
        <span className={styles.timer}>{formatElapsed(elapsed)}</span>
      </div>
      <button
        className={styles.stopButton}
        onClick={handleStop}
        disabled={isStopping}
      >
        <Square size={12} fill="currentColor" strokeWidth={0} />
        {isStopping ? 'Finalizing…' : 'Stop & Process'}
      </button>
      <p className={styles.hint}>
        {isStopping ? 'Writing the mp4 — this takes a second' : 'Recording the full desktop'}
      </p>
    </div>
  );
}
