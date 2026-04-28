import { motion } from 'framer-motion';
import styles from './ProgressView.module.css';

interface ProgressViewProps {
  current: number;
  total: number;
  lastSnippet: string;
}

export default function ProgressView({ current, total, lastSnippet }: ProgressViewProps) {
  const percent = total > 0 ? Math.min(100, (current / total) * 100) : 0;

  return (
    <motion.div 
      className={styles.container}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
    >
      <div className={styles.statusText}>
        Processing frame {current} of {total}
      </div>
      
      <div className={styles.barTrack}>
        <motion.div 
          className={styles.barFill}
          initial={{ width: 0 }}
          animate={{ width: `${percent}%` }}
          transition={{ ease: "easeOut", duration: 0.3 }}
        />
      </div>

      <div className={styles.snippetCard}>
        <div className={styles.snippetHeader}>LATEST OCR RESULT</div>
        <div className={styles.snippetText}>
          {lastSnippet || 'Waiting for text...'}
        </div>
      </div>
    </motion.div>
  );
}
