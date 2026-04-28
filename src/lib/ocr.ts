import Tesseract from 'tesseract.js';
import { deduplicateText } from './dedup';

export async function ocrImage(imagePath: string, language: string): Promise<string> {
  try {
    // tesseract.js recognize can take a URL or a file path in Node.
    // In Tauri (browser context), we might need to load the file as a Blob or array buffer first.
    // However, Tesseract.js in a browser can take an image element, canvas, or a File/Blob.
    // We must read the file from disk using Tauri fs plugin and pass it as a buffer/Blob.
    
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const fileData = await readFile(imagePath);
    
    // Convert Uint8Array to Blob
    const blob = new Blob([fileData], { type: 'image/png' });
    
    const result = await Tesseract.recognize(blob, language, {
      // logger: m => console.log(m) // Optional logger
    });
    
    return result.data.text.trim();
  } catch (error) {
    console.error(`OCR failed for ${imagePath}:`, error);
    return '';
  }
}

export async function runOcrPipeline(
  framePaths: string[],
  language: string,
  dedupeThreshold: number,
  onFrameDone: (frameIndex: number, text: string) => void
): Promise<string> {
  const framesText: string[] = [];
  
  for (let i = 0; i < framePaths.length; i++) {
    const text = await ocrImage(framePaths[i], language);
    framesText.push(text);
    onFrameDone(i, text);
  }

  return deduplicateText(framesText, dedupeThreshold);
}
