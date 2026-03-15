import { execFile } from "node:child_process";
import { stat, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DownloadResult } from "./types.js";
import type { MediaConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/** Player client strategies to try when YouTube blocks requests */
const FALLBACK_PLAYER_CLIENTS = [
  undefined,                       // default (no override)
  "web_creator,mediaconnect",      // fallback 1: web_creator + mediaconnect
  "ios,web_creator",               // fallback 2: iOS + web_creator
];

const AUTH_ERROR_PATTERNS = [
  "Sign in to confirm you're not a bot",
  "Sign in to confirm your age",
  "This request was detected as a bot",
];

/** Copy cookies to a writable temp path so yt-dlp can save updates */
async function getWritableCookiesArgs(config: MediaConfig): Promise<string[]> {
  if (!config.cookiesFile) return [];
  const tempCookies = join(config.mediaDir, ".cookies.tmp.txt");
  await copyFile(config.cookiesFile, tempCookies);
  return ["--cookies", tempCookies];
}

/** Common args for yt-dlp: JS runtime for n challenge + cookies */
async function baseArgs(config: MediaConfig): Promise<string[]> {
  return ["--js-runtimes", "node", ...(await getWritableCookiesArgs(config))];
}

/** Check both error.message and error.stderr (execFile puts output in stderr) */
function isYouTubeAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: string }).stderr ?? "";
  const combined = `${msg}\n${stderr}`;
  return AUTH_ERROR_PATTERNS.some((p) => combined.includes(p));
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

  const common = await baseArgs(config);

  const ext = mode === "audio" ? "mp3" : "mp4";
  const outputPath = join(config.mediaDir, `${slug}_${timestamp}.${ext}`);

  const modeArgs = mode === "audio"
    ? ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "128K"]
    : ["-S", `res:${config.videoMaxHeight}`, "--merge-output-format", "mp4"];

  let lastError: unknown;

  for (const playerClient of FALLBACK_PLAYER_CLIENTS) {
    const args = [
      ...common,
      ...(playerClient
        ? ["--extractor-args", `youtube:player_client=${playerClient}`]
        : []),
      ...modeArgs,
      "--no-playlist",
      "--no-warnings",
      "-o", outputPath,
      url,
    ];

    try {
      await execFileAsync("yt-dlp", args, { timeout: config.downloadTimeoutMs });
      const stats = await stat(outputPath);
      return { filePath: outputPath, fileSizeBytes: stats.size, format: ext as "mp3" | "mp4" };
    } catch (err) {
      lastError = err;
      if (!isYouTubeAuthError(err)) throw err;
      // Auth error — try next player client
    }
  }

  // All fallback player clients exhausted
  throw lastError;
}
