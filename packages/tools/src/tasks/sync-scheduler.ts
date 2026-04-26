import { pullAllProjects, type GitSyncResult } from "./git-sync.js";

const DEFAULT_POLL_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const QUIET_HOURS_START = 0; // midnight
const QUIET_HOURS_END = 6; // 6 AM

export interface SyncSchedulerOpts {
  repoPaths: string[];
  pollIntervalMs?: number;
  onConflict?: (repoPath: string, result: GitSyncResult) => void;
  onError?: (repoPath: string, error: Error) => void;
}

function isDuringQuietHours(): boolean {
  const hour = new Date().getHours();
  return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

/**
 * Start periodic git pull on all project repos.
 * Skips sync during quiet hours (midnight–6 AM).
 * Returns interval handle for cleanup on shutdown.
 */
export function startSyncScheduler(opts: SyncSchedulerOpts): ReturnType<typeof setInterval> {
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const runSync = async () => {
    if (isDuringQuietHours()) return;

    const results = await pullAllProjects(opts.repoPaths);

    for (const [repoPath, result] of results) {
      if (result.action === "conflict" && opts.onConflict) {
        opts.onConflict(repoPath, result);
      }
      if (result.action === "error" && opts.onError) {
        opts.onError(repoPath, new Error(result.message));
      }
    }
  };

  // Run once on startup
  runSync().catch((err) => {
    console.error("[sync-scheduler] Initial sync failed:", err);
  });

  // Then on interval
  return setInterval(() => {
    runSync().catch((err) => {
      console.error("[sync-scheduler] Sync failed:", err);
    });
  }, interval);
}
