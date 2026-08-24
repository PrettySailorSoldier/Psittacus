import { useState } from 'react';
import { Copy, Save, RotateCcw, Sparkles, Loader2 } from 'lucide-react';
import { save as dialogSave } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import styles from './OutputView.module.css';
import { cleanupExtractedText } from '../../lib/textCleanup';

interface OutputViewProps {
  text: string;
  wordCount: number;
  frameCount: number;
  exportFormat: 'txt' | 'md';
  onReset: () => void;
  /**
   * Raw per-frame OCR output. Cleanup runs from this rather than from the
   * already-deduplicated `text`, so the model sees the extraction as it came
   * off the frames.
   */
  rawFrameTexts: string[];
}

type View = 'raw' | 'cleaned';

export default function OutputView({
  text,
  wordCount,
  frameCount,
  exportFormat,
  onReset,
  rawFrameTexts,
}: OutputViewProps) {
  const [copied, setCopied] = useState(false);

  // Cleanup is opt-in and never replaces the raw extraction — both are kept in
  // state and the toggle chooses which one is shown, copied and saved.
  const [view, setView] = useState<View>('raw');
  const [cleanedText, setCleanedText] = useState<string | null>(null);
  const [isCleaning, setIsCleaning] = useState(false);
  const [cleanupProgress, setCleanupProgress] = useState({ done: 0, total: 0 });
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const shownText = view === 'cleaned' && cleanedText !== null ? cleanedText : text;
  const shownWordCount =
    view === 'cleaned' && cleanedText !== null
      ? cleanedText.split(/\s+/).filter(Boolean).length
      : wordCount;

  const handleCleanup = async () => {
    setIsCleaning(true);
    setCleanupError(null);
    setCleanupProgress({ done: 0, total: 0 });

    try {
      const result = await cleanupExtractedText(rawFrameTexts, (done, total) =>
        setCleanupProgress({ done, total })
      );
      setCleanedText(result);
      setView('cleaned');
    } catch (e) {
      console.error('Cleanup failed', e);
      setCleanupError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsCleaning(false);
    }
  };

  const handleCopy = async () => {
    try {
      await writeText(shownText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy', e);
      alert('Clipboard copy failed.');
    }
  };

  const handleSave = async () => {
    try {
      const ext = exportFormat === 'md' ? 'md' : 'txt';
      const path = await dialogSave({
        filters: [{
          name: 'Text Document',
          extensions: [ext]
        }],
        // Name the file after which version is on screen, so a raw and a
        // cleaned export of the same run don't silently overwrite each other.
        defaultPath: view === 'cleaned' ? `extraction-cleaned.${ext}` : `extraction.${ext}`
      });

      if (path) {
        await writeTextFile(path, shownText);
      }
    } catch (e) {
      console.error('Failed to save file', e);
      alert('File save failed.');
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.topBar}>
        <div className={styles.statsBar}>
          {shownWordCount} words &middot; extracted from {frameCount} frames
          {view === 'cleaned' && cleanedText !== null && (
            <span className={styles.deltaNote}>
              &middot; {wordCount - shownWordCount >= 0 ? '-' : '+'}
              {Math.abs(wordCount - shownWordCount)} vs raw
            </span>
          )}
        </div>

        <div className={styles.toggleGroup} role="tablist" aria-label="Output version">
          <button
            role="tab"
            aria-selected={view === 'raw'}
            className={`${styles.toggleBtn} ${view === 'raw' ? styles.toggleActive : ''}`}
            onClick={() => setView('raw')}
          >
            Raw OCR
          </button>
          <button
            role="tab"
            aria-selected={view === 'cleaned'}
            className={`${styles.toggleBtn} ${view === 'cleaned' ? styles.toggleActive : ''}`}
            onClick={() => setView('cleaned')}
            disabled={cleanedText === null}
            title={cleanedText === null ? 'Run cleanup first' : undefined}
          >
            Cleaned up
          </button>
        </div>
      </div>

      {cleanupError && (
        <div className={styles.errorBar}>
          Cleanup failed: {cleanupError}
        </div>
      )}

      <div className={styles.textAreaWrapper}>
        <textarea
          className={styles.textArea}
          value={shownText}
          readOnly
        />
      </div>

      <div className={styles.actionBar}>
        <button className={styles.ghostBtn} onClick={onReset}>
          <RotateCcw size={16} /> Start over
        </button>

        <div className={styles.rightActions}>
          <button
            className={styles.ghostBtn}
            onClick={handleCleanup}
            disabled={isCleaning || rawFrameTexts.length === 0}
          >
            {isCleaning ? (
              <>
                <Loader2 size={16} className={styles.spin} />
                {cleanupProgress.total > 0
                  ? `Cleaning ${cleanupProgress.done}/${cleanupProgress.total}...`
                  : 'Cleaning...'}
              </>
            ) : (
              <>
                <Sparkles size={16} /> {cleanedText === null ? 'Clean up text' : 'Re-run cleanup'}
              </>
            )}
          </button>

          <button className={styles.primaryBtn} onClick={handleCopy}>
            <Copy size={16} /> {copied ? 'Copied!' : 'Copy to clipboard'}
          </button>

          <button className={styles.primaryBtn} onClick={handleSave}>
            <Save size={16} /> Save file
          </button>
        </div>
      </div>
    </div>
  );
}
