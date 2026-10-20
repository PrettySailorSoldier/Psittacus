import { MousePointerClick, Square } from 'lucide-react';
import styles from './AutoCapture.module.css';
import type { AutoCaptureProgress } from '../../lib/autoCapture';

interface AutoCaptureViewProps {
  progress: AutoCaptureProgress | null;
  maxSections: number;
  onStop: () => void;
}

/**
 * Status while auto-capture runs.
 *
 * Once the countdown ends the window turns click-through so scrolls and
 * clicks reach the browser beneath it — the Stop button only works during
 * the countdown, and Esc is the way to stop after that.
 */
export default function AutoCaptureView({ progress, maxSections, onStop }: AutoCaptureViewProps) {
  const counting = progress === null || progress.phase === 'countdown';

  return (
    <div className={styles.view}>
      <div className={styles.warning}>
        <MousePointerClick size={16} />
        <span>
          Psittacus is using your mouse and keyboard. Don't touch them while it runs.
          Press <kbd>Esc</kbd> to stop.
        </span>
      </div>

      {counting ? (
        <>
          <div className={styles.countdown}>{progress?.countdown ?? '…'}</div>
          <div className={styles.status}>Click the browser window now so it has focus</div>
        </>
      ) : (
        <>
          <div className={styles.counters}>
            <div>
              <div className={styles.counterValue}>
                {progress.section}<span className={styles.counterOf}> / {maxSections}</span>
              </div>
              <div className={styles.label}>Section</div>
            </div>
            <div>
              <div className={styles.counterValue}>{progress.frames}</div>
              <div className={styles.label}>Frames</div>
            </div>
          </div>
          <div className={styles.status}>{progress.message}</div>
        </>
      )}

      <button className={styles.stopButton} onClick={onStop} disabled={!counting}>
        <Square size={12} fill="currentColor" strokeWidth={0} />
        {counting ? 'Cancel' : 'Press Esc to stop'}
      </button>
    </div>
  );
}
