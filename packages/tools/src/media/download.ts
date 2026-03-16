import { spawn } from "node:child_process";
import { stat, mkdir, copyFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DownloadResult } from "./types.js";
import type { MediaConfig } from "./config.js";

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

/** Copy cookies to a unique writable temp path so yt-dlp can save updates */
async function getWritableCookiesArgs(config: MediaConfig): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const noop = { args: [] as string[], cleanup: async () => {} };
  if (!config.cookiesFile) return noop;

  // Verify source cookies path is a file, not a directory (e.g. stale Docker volume mount)
  const srcStat = await stat(config.cookiesFile).catch(() => null);
  if (!srcStat || srcStat.isDirectory()) return noop;

  // Use a unique temp dir per invocation to avoid EISDIR races with concurrent requests
  const tempDir = await mkdtemp(join(tmpdir(), "yt-cookies-"));
  const tempCookies = join(tempDir, "cookies.txt");
  await copyFile(config.cookiesFile, tempCookies);
  return {
    args: ["--cookies", tempCookies],
    cleanup: () => rm(tempDir, { recursive: true }).catch(() => {}),
  };
}

/** Common args for yt-dlp: JS runtime for n challenge + cookies + network safety */
async function baseArgs(config: MediaConfig): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const cookies = await getWritableCookiesArgs(config);
  return {
    args: [
      "--js-runtimes", "node",
      "--socket-timeout", "30",   // abort if a socket stalls for 30s
      "--retries", "3",           // limit internal retries
      "--abort-on-unavailable-fragments",
      ...cookies.args,
    ],
    cleanup: cookies.cleanup,
  };
}

/**
 * Run a command with a timeout that kills the entire process group.
 * Unlike execFile's timeout (which only SIGTERMs the parent), this
 * ensures child processes (e.g. ffmpeg spawned by yt-dlp) are killed too.
 */
function spawnWithGroupKill(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: true,          // create a new process group
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let done = false;

    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      killed = true;
      // Kill entire process group (negative PID) so child processes die too
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killed) {
        const err = Object.assign(new Error(`timed out after ${timeoutMs}ms`), { killed: true, stderr });
        reject(err);
      } else if (code !== 0) {
        const err = Object.assign(
          new Error(`yt-dlp exited with code ${code}\n${stderr}`),
          { code, stderr },
        );
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    };

    child.on("close", finish);
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
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
  onRetry?: (attempt: number, total: number, reason: string) => void;
}

/** Per-attempt timeout: cap at 3 minutes to avoid long hangs per fallback */
const PER_ATTEMPT_TIMEOUT_MS = 180_000;

export async function downloadVideo(opts: DownloadOptions): Promise<DownloadResult> {
  const { url, title, mode, config, onRetry } = opts;
  await mkdir(config.mediaDir, { recursive: true });

  const slug = slugify(title);
  const timestamp = Date.now();

  const { args: common, cleanup } = await baseArgs(config);

  try {
    const ext = mode === "audio" ? "mp3" : "mp4";
    const outputPath = join(config.mediaDir, `${slug}_${timestamp}.${ext}`);

    const modeArgs = mode === "audio"
      ? ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "128K"]
      : ["-S", `res:${config.videoMaxHeight}`, "--merge-output-format", "mp4"];

    const attemptTimeout = Math.min(config.downloadTimeoutMs, PER_ATTEMPT_TIMEOUT_MS);
    const totalClients = FALLBACK_PLAYER_CLIENTS.length;
    let lastError: unknown;

    for (let i = 0; i < totalClients; i++) {
      const playerClient = FALLBACK_PLAYER_CLIENTS[i];
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
        await spawnWithGroupKill("yt-dlp", args, attemptTimeout);
        const stats = await stat(outputPath);
        return { filePath: outputPath, fileSizeBytes: stats.size, format: ext as "mp3" | "mp4" };
      } catch (err) {
        lastError = err;
        const isTimeout = (err as { killed?: boolean }).killed === true;
        const isAuth = isYouTubeAuthError(err);

        if (!isTimeout && !isAuth) throw err;

        const reason = isTimeout ? "timed out" : "blocked by YouTube";
        if (i < totalClients - 1) {
          onRetry?.(i + 1, totalClients, reason);
        }
      }
    }

    // All fallback player clients exhausted
    throw lastError;
  } finally {
    await cleanup();
  }
}
