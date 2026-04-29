import { deduplicateText } from './dedup';

async function imageToBase64(imagePath: string): Promise<string> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(imagePath);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function ocrImage(imagePath: string, _language: string): Promise<string> {
  try {
    const base64 = await imageToBase64(imagePath);

    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'moondream',
        prompt: 'Extract all text from this image exactly as it appears. Preserve the original formatting: headings, paragraphs, bullet points, indentation, and line breaks. Output only the extracted text, nothing else.',
        images: [base64],
        stream: false,
      }),
    });

    if (!response.ok) throw new Error(`Ollama error: ${response.status}`);
    const data = await response.json();
    return (data.response ?? '').trim();
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
