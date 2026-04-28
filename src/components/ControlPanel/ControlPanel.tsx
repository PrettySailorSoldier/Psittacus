import styles from './ControlPanel.module.css';
import { Settings } from '../../store/settings';

interface ControlPanelProps {
  settings: Settings;
  onChange: (s: Settings) => void;
  onRun: () => void;
  disabled: boolean;
  fileDuration: number;
}

export default function ControlPanel({ settings, onChange, onRun, disabled, fileDuration }: ControlPanelProps) {
  const estimatedFrames = Math.ceil(fileDuration / settings.sampleInterval);

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        
        {/* Sample Interval */}
        <div className={styles.controlGroup}>
          <label className={styles.label}>Sample every</label>
          <div className={styles.segmented}>
            {[0.5, 1, 2, 3, 5].map(val => (
              <button
                key={val}
                className={`${styles.segment} ${settings.sampleInterval === val ? styles.active : ''}`}
                onClick={() => onChange({ ...settings, sampleInterval: val })}
                disabled={disabled}
              >
                {val}s
              </button>
            ))}
          </div>
        </div>

        {/* Dedupe */}
        <div className={styles.controlGroup}>
          <label className={styles.label}>Dedupe</label>
          <button 
            className={`${styles.toggle} ${settings.dedupeThreshold === 0.85 ? styles.active : ''}`}
            onClick={() => onChange({ ...settings, dedupeThreshold: settings.dedupeThreshold === 0.85 ? 1.0 : 0.85 })}
            disabled={disabled}
          >
            {settings.dedupeThreshold === 0.85 ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* Export Format */}
        <div className={styles.controlGroup}>
          <label className={styles.label}>Export as</label>
          <div className={styles.segmented}>
            {['txt', 'md'].map(fmt => (
              <button
                key={fmt}
                className={`${styles.segment} ${settings.exportFormat === fmt ? styles.active : ''}`}
                onClick={() => onChange({ ...settings, exportFormat: fmt as 'txt' | 'md' })}
                disabled={disabled}
              >
                {fmt.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.spacer} />

        {/* Run Button */}
        <button 
          className={styles.runButton} 
          onClick={onRun} 
          disabled={disabled || estimatedFrames === 0}
        >
          Extract Text &rarr;
        </button>

      </div>

      {estimatedFrames > 0 && (
        <div className={styles.footer}>
          ~{estimatedFrames} frames to process
        </div>
      )}
    </div>
  );
}
