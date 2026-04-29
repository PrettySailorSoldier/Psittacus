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

function cleanResponse(text: string): string {
  return text
    .replace(/```[\w]*\n?/g, '')        // strip code fences
    .replace(/^The image (shows|displays|contains|depicts)[^\n]*\n?/gim, '')
    .replace(/^Here is the (extracted )?text:?\n?/gim, '')
    .replace(/^I can see[^\n]*\n?/gim, '')
    .replace(/^This (image|screenshot|document)[^\n]*\n?/gim, '')
    .trim();
}

export async function ocrImage(imagePath: string, _language: string): Promise<string> {
  try {
    const base64 = await imageToBase64(imagePath);
    console.log(`[OCR] sending frame to Ollama: ${imagePath}`);

    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llava',
        prompt: 'Transcribe only the document text visible in this image. Do not describe the image. Do not add any commentary. Do not use code blocks. Output only the raw text exactly as it appears, preserving headings and paragraphs.',
        images: [base64],
        stream: false,
      }),
    });

    console.log(`[OCR] response status: ${response.status}`);
    if (!response.ok) throw new Error(`Ollama error: ${response.status}`);
    const data = await response.json();
    console.log(`[OCR] response data:`, data);
    return cleanResponse((data.response ?? '').trim());
  } catch (error) {
    console.error(`[OCR] failed for ${imagePath}:`, error);
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
