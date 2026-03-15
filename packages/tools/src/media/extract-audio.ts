import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { AudioExtractionResult } from "./types.js";

const execFileAsync = promisify(execFile);

export async function extractAudio(
  videoPath: string,
  audioPath: string,
  bitrate = "128k",
  timeoutMs = 300_000,
): Promise<AudioExtractionResult> {
  const args = [
    "-i", videoPath,
    "-vn",
    "-ab", bitrate,
    "-ar", "44100",
    "-y",
    audioPath,
  ];

  await execFileAsync("ffmpeg", args, { timeout: timeoutMs });

  // Get duration from ffprobe
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ]);

  const durationSeconds = Math.round(parseFloat(stdout.trim()) || 0);
  const stats = await stat(audioPath);

  return {
    filePath: audioPath,
    fileSizeBytes: stats.size,
    durationSeconds,
  };
}
