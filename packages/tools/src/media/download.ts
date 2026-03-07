import { execFile } from "node:child_process";
import { stat, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DownloadResult } from "./types.js";
import type { MediaConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/** Copy cookies to a writable temp path so yt-dlp can save updates */
async function getWritableCookiesArgs(config: MediaConfig): Promise<string[]> {
  if (!config.cookiesFile) return [];
  const tempCookies = join(config.mediaDir, ".cookies.tmp.txt");
  await copyFile(config.cookiesFile, tempCookies);
  return ["--cookies", tempCookies];
}

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

  const cookiesArgs = await getWritableCookiesArgs(config);

  if (mode === "audio") {
    const outputPath = join(config.mediaDir, `${slug}_${timestamp}.mp3`);
    const args = [
      ...cookiesArgs,
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

  // Video mode — use format sorting for flexible format selection
  const h = config.videoMaxHeight;
  const outputPath = join(config.mediaDir, `${slug}_${timestamp}.mp4`);
  const args = [
    ...cookiesArgs,
    "-S", `res:${h}`,
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
