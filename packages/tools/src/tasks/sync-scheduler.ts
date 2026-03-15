import { pullAllProjects, type GitSyncResult } from "./git-sync.js";

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface SyncSchedulerOpts {
  repoPaths: string[];
  pollIntervalMs?: number;
  onConflict?: (repoPath: string, result: GitSyncResult) => void;
  onError?: (repoPath: string, error: Error) => void;
}

/**
 * Start periodic git pull on all project repos.
 * Returns interval handle for cleanup on shutdown.
 */
export function startSyncScheduler(opts: SyncSchedulerOpts): ReturnType<typeof setInterval> {
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const runSync = async () => {
    const results = await pullAllProjects(opts.repoPaths);

    for (const [repoPath, result] of results) {
      if (result.action === "conflict" && opts.onConflict) {
        opts.onConflict(repoPath, result);
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
