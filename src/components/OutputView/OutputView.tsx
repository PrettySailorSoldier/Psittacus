import { useState } from 'react';
import { Copy, Save, RotateCcw } from 'lucide-react';
import { save as dialogSave } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import styles from './OutputView.module.css';

interface OutputViewProps {
  text: string;
  wordCount: number;
  frameCount: number;
  exportFormat: 'txt' | 'md';
  onReset: () => void;
}

export default function OutputView({ text, wordCount, frameCount, exportFormat, onReset }: OutputViewProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await writeText(text);
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
        defaultPath: `extraction.${ext}`
      });

      if (path) {
        await writeTextFile(path, text);
      }
    } catch (e) {
      console.error('Failed to save file', e);
      alert('File save failed.');
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.statsBar}>
        {wordCount} words &middot; extracted from {frameCount} frames
      </div>

      <div className={styles.textAreaWrapper}>
        <textarea 
          className={styles.textArea} 
          value={text} 
          readOnly 
        />
      </div>

      <div className={styles.actionBar}>
        <button className={styles.ghostBtn} onClick={onReset}>
          <RotateCcw size={16} /> Start over
        </button>
        
        <div className={styles.rightActions}>
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
