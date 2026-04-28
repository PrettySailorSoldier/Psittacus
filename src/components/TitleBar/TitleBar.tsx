import { getCurrentWindow } from '@tauri-apps/api/window';
import styles from './TitleBar.module.css';
import { Minus, X } from 'lucide-react';

export default function TitleBar() {
  const appWindow = getCurrentWindow();

  return (
    <div data-tauri-drag-region className={styles.titlebar}>
      <div data-tauri-drag-region className={styles.title}>
        Psittacus
      </div>
      <div className={styles.controls}>
        <div className={styles.button} onClick={() => appWindow.minimize()}>
          <Minus size={16} />
        </div>
        <div className={`${styles.button} ${styles.close}`} onClick={() => appWindow.close()}>
          <X size={16} />
        </div>
      </div>
    </div>
  );
}
