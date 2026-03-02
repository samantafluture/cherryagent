import { execFile } from "node:child_process";
import { stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DownloadResult } from "./types.js";
import type { MediaConfig } from "./config.js";

const execFileAsync = promisify(execFile);

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

export interface DownloadOptions {
  url: string;
  title: string;
  mode: "video" | "audio";
  config: MediaConfig;
}

export async function downloadVideo(opts: DownloadOptions): Promise<DownloadResult> {
  const { url, title, mode, config } = opts;
  await mkdir(config.mediaDir, { recursive: true });

  const slug = slugify(title);
  const timestamp = Date.now();

  if (mode === "audio") {
    const outputPath = join(config.mediaDir, `${slug}_${timestamp}.mp3`);
    const args = [
      "-f", "ba/b",  // best audio, fallback to best combined
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "128K",
      "--no-playlist",
      "--no-warnings",
      "-o", outputPath,
      url,
    ];

    await execFileAsync("yt-dlp", args, { timeout: 300_000 });

    const stats = await stat(outputPath);
    return { filePath: outputPath, fileSizeBytes: stats.size, format: "mp3" };
  }

  // Video mode — use format sorting for reliable mp4 merging
  const h = config.videoMaxHeight;
  const outputPath = join(config.mediaDir, `${slug}_${timestamp}.mp4`);
  const args = [
    "-f", `bv[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/b[height<=${h}]`,
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--no-warnings",
    "-o", outputPath,
    url,
  ];

  await execFileAsync("yt-dlp", args, { timeout: 300_000 });

  const stats = await stat(outputPath);
  return { filePath: outputPath, fileSizeBytes: stats.size, format: "mp4" };
}
