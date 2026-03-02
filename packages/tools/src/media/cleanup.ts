import { readdir, stat, unlink } from "node:fs/promises";
import { join, extname } from "node:path";
import type { MediaConfig } from "./config.js";

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function runCleanup(config: MediaConfig): Promise<number> {
  const now = Date.now();
  let deleted = 0;

  let entries: string[];
  try {
    entries = await readdir(config.mediaDir);
  } catch {
    return 0; // dir doesn't exist yet
  }

  for (const entry of entries) {
    const filePath = join(config.mediaDir, entry);
    const ext = extname(entry).toLowerCase();

    let maxAgeMs: number;
    if (ext === ".mp4") {
      maxAgeMs = config.videoRetentionHours * 60 * 60 * 1000;
    } else if (ext === ".mp3") {
      maxAgeMs = config.audioRetentionHours * 60 * 60 * 1000;
    } else if (ext === ".md" || ext === ".txt") {
      maxAgeMs = config.notesRetentionDays * 24 * 60 * 60 * 1000;
    } else {
      continue;
    }

    try {
      const stats = await stat(filePath);
      if (now - stats.mtimeMs > maxAgeMs) {
        await unlink(filePath);
        deleted++;
      }
    } catch {
      // file may have been deleted concurrently
    }
  }

  return deleted;
}

export function startMediaCleanup(config: MediaConfig): ReturnType<typeof setInterval> {
  // Run once on startup
  runCleanup(config).then((n) => {
    if (n > 0) console.log(`[media-cleanup] Deleted ${n} expired files`);
  });

  // Then every 6 hours
  return setInterval(() => {
    runCleanup(config).then((n) => {
      if (n > 0) console.log(`[media-cleanup] Deleted ${n} expired files`);
    });
  }, CLEANUP_INTERVAL_MS);
}
