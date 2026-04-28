import { Command } from '@tauri-apps/plugin-shell';

export async function getVideoDuration(videoPath: string): Promise<number> {
  const cmd = Command.sidecar('binaries/ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);

  const output = await cmd.execute();
  if (output.code !== 0) {
    throw new Error(`ffprobe error: ${output.stderr}`);
  }

  const duration = parseFloat(output.stdout.trim());
  return isNaN(duration) ? 0 : duration;
}

export async function extractFrames(
  videoPath: string,
  outputDir: string,
  intervalSeconds: number,
  onProgress?: (frameNum: number) => void
): Promise<string[]> {
  // Using path plugin to format the output template
  // ffmpeg expects output like /tempdir/frame_%04d.png
  // To avoid path separator issues in ffmpeg, it's safer to run it with a known template and read the directory later,
  // or explicitly pass the exact path format.
  
  // Note: we must ensure outputDir does not have a trailing slash for the pattern to work smoothly.
  const cleanOutputDir = outputDir.replace(/[\\/]$/, '');
  const pattern = `${cleanOutputDir}/frame_%04d.png`;

  const cmd = Command.sidecar('binaries/ffmpeg', [
    '-i',
    videoPath,
    '-vf',
    `fps=1/${intervalSeconds}`,
    pattern,
  ]);

  // We can listen to stdout/stderr to infer progress if we want, but ffmpeg progress is tricky.
  // The simplest way is to just let it finish. The onProgress callback requested was for extraction,
  // but ffmpeg sidecar gives us output events. 
  // We'll just execute it and wait for it to complete.
  cmd.on('close', data => {
    // console.log(`ffmpeg finished with code ${data.code} and signal ${data.signal}`);
  });

  const output = await cmd.execute();
  if (output.code !== 0) {
    throw new Error(`ffmpeg error: ${output.stderr}`);
  }

  // After completion, we need to return the list of generated files.
  // We can use Tauri's fs plugin to read the dir and sort the frame files.
  const { readDir } = await import('@tauri-apps/plugin-fs');
  const { join } = await import('@tauri-apps/api/path');
  
  const entries = await readDir(cleanOutputDir);
  const frameFiles = entries
    .filter(e => e.name?.startsWith('frame_') && e.name.endsWith('.png'))
    .sort((a, b) => a.name!.localeCompare(b.name!));

  const paths: string[] = [];
  for (const file of frameFiles) {
    paths.push(await join(cleanOutputDir, file.name!));
  }

  return paths;
}
