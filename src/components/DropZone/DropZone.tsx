import { useState } from 'react';
import { Film, X } from 'lucide-react';
import { AppState, FileInfo } from '../../App';
import styles from './DropZone.module.css';

interface DropZoneProps {
  state: AppState;
  file: FileInfo | null;
  onFileDrop: (path: string) => void;
  onClick?: () => void;
  onClear?: () => void;
}

export default function DropZone({ state, file, onClick, onClear }: DropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  // Note: Actual drag/drop logic for files is handled at the App level 
  // by listening to tauri://drag-drop event, since Tauri handles file drops over the window.
  // We just manage the visual hover state here.
  
  // Tauri doesn't easily expose dragover events globally to React without a plugin or DOM trickery,
  // but we can listen to standard HTML drag events just for visual feedback if a file enters the window.
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  if (state === 'ready' && file) {
    return (
      <div className={styles.readyStrip}>
        <Film size={20} className={styles.iconSmall} />
        <span className={styles.filename} title={file.name}>{file.name}</span>
        <button className={styles.clearBtn} onClick={onClear}>
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div 
      className={`${styles.container} ${isDragOver ? styles.dragOver : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={onClick}
    >
      <div className={styles.inner}>
        <Film size={48} strokeWidth={1} className={styles.iconLarge} />
        <h2 className={styles.title}>Drop a video or recording</h2>
        <p className={styles.subtitle}>mp4 · mov · mkv · webm · avi</p>
      </div>
    </div>
  );
}
