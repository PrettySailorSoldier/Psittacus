import { useEffect, useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import styles from './AutoCapture.module.css';
import { Settings } from '../../store/settings';

interface AutoCapturePanelProps {
  settings: Settings;
  onChange: (s: Settings) => void;
  onStart: () => void;
  disabled?: boolean;
}

const STEP_CHOICES = [0.6, 0.7, 0.75, 0.8];

/** Idle-screen controls for auto-capture: its settings and the Start button. */
export default function AutoCapturePanel({ settings, onChange, onStart, disabled = false }: AutoCapturePanelProps) {
  // Edited as free text and parsed on blur, so typing a comma does not
  // immediately produce an empty label.
  const [labels, setLabels] = useState(settings.autoNextLabels.join(', '));
  useEffect(() => setLabels(settings.autoNextLabels.join(', ')), [settings.autoNextLabels]);

  const commitLabels = () => {
    const parsed = labels.split(',').map(l => l.trim()).filter(Boolean);
    onChange({ ...settings, autoNextLabels: parsed });
  };

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        <button className={styles.startButton} onClick={onStart} disabled={disabled}>
          <MousePointerClick size={14} />
          Auto-capture
        </button>

        <div className={styles.controlGroup}>
          <label className={styles.label} htmlFor="auto-max-sections">Max sections</label>
          <input
            id="auto-max-sections"
            className={styles.numberInput}
            type="number"
            min={1}
            max={200}
            value={settings.autoMaxSections}
            onChange={e => {
              const value = Math.max(1, Math.min(200, Math.round(Number(e.target.value) || 1)));
              onChange({ ...settings, autoMaxSections: value });
            }}
            disabled={disabled}
          />
        </div>

        <div className={styles.controlGroup}>
          <span className={styles.label}>Scroll step</span>
          <div className={styles.segmented}>
            {STEP_CHOICES.map(step => (
              <button
                key={step}
                className={`${styles.segment} ${settings.autoScrollStep === step ? styles.active : ''}`}
                onClick={() => onChange({ ...settings, autoScrollStep: step })}
                disabled={disabled}
                title={`Scroll ${Math.round(step * 100)}% of the capture height per step`}
              >
                {Math.round(step * 100)}%
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.row}>
        <div className={`${styles.controlGroup} ${styles.grow}`}>
          <label className={styles.label} htmlFor="auto-next-labels">Next button labels</label>
          <input
            id="auto-next-labels"
            className={styles.textInput}
            value={labels}
            onChange={e => setLabels(e.target.value)}
            onBlur={commitLabels}
            disabled={disabled}
            placeholder="Next, Continue"
          />
        </div>

        <label className={styles.checkbox} title="For sites whose next link is the next section's title, e.g. “Keeping on Track →”">
          <input
            type="checkbox"
            checked={settings.autoArrowLinks}
            onChange={e => onChange({ ...settings, autoArrowLinks: e.target.checked })}
            disabled={disabled}
          />
          Follow “Title →” links
        </label>
      </div>

      <p className={styles.hint}>
        Scrolls the browser page by page and clicks Next for you. It takes over the mouse
        while it runs. Press <kbd>Esc</kbd> to stop.
      </p>
    </div>
  );
}
