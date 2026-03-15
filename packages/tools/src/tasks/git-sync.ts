import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TASK_COMMIT_MSG = "chore: update tasks";
const GIT_TIMEOUT = 30_000; // 30 seconds

export interface GitSyncResult {
  action: "created" | "amended" | "pulled" | "conflict" | "no-change";
  message: string;
}

/**
 * Commit task file changes and push to GitHub.
 * Squashes consecutive task commits by amending when the last commit
 * message matches TASK_COMMIT_MSG.
 */
export async function commitAndPush(repoPath: string): Promise<GitSyncResult> {
  // Stage the task file
  await git(repoPath, ["add", ".claude/tasks.md"]);

  // Check if there are staged changes
  const { stdout: diffOutput } = await git(repoPath, ["diff", "--cached", "--name-only"]);
  if (!diffOutput.trim()) {
    return { action: "no-change", message: "No task changes to commit" };
  }

  // Check if last commit was a task update (squash candidate)
  const { stdout: lastMsg } = await git(repoPath, ["log", "-1", "--pretty=%s"]);
  const shouldAmend = lastMsg.trim() === TASK_COMMIT_MSG;

  if (shouldAmend) {
    await git(repoPath, ["commit", "--amend", "--no-edit"]);
    await git(repoPath, ["push", "--force-with-lease"]);
    return { action: "amended", message: "Amended previous task commit and pushed" };
  } else {
    await git(repoPath, ["commit", "-m", TASK_COMMIT_MSG]);
    await git(repoPath, ["push"]);
    return { action: "created", message: "Created task commit and pushed" };
  }
}

/**
 * Pull latest changes from GitHub.
 * Handles conflicts by keeping VPS state and stashing remote changes.
 */
export async function pullChanges(repoPath: string): Promise<GitSyncResult> {
  // Check for uncommitted local changes first
  const { stdout: statusOut } = await git(repoPath, ["status", "--porcelain", ".claude/tasks.md"]);
  if (statusOut.trim()) {
    // Local uncommitted changes — commit them first to avoid losing work
    await commitAndPush(repoPath);
  }

  try {
    await git(repoPath, ["pull", "--rebase=false"]);
    return { action: "pulled", message: "Pulled latest changes" };
  } catch (err) {
    // Merge conflict — abort and keep VPS state
    const error = err as Error & { stderr?: string };
    if (error.stderr?.includes("CONFLICT") || error.message?.includes("CONFLICT")) {
      await git(repoPath, ["merge", "--abort"]).catch(() => {});
      return {
        action: "conflict",
        message: "Merge conflict detected — VPS state preserved. Remote changes need manual review.",
      };
    }
    throw err;
  }
}

/**
 * Pull all project repos. Returns results keyed by repo path.
 */
export async function pullAllProjects(
  repoPaths: string[]
): Promise<Map<string, GitSyncResult>> {
  const results = new Map<string, GitSyncResult>();

  for (const repoPath of repoPaths) {
    try {
      const result = await pullChanges(repoPath);
      results.set(repoPath, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.set(repoPath, { action: "conflict", message: `Pull failed: ${message}` });
    }
  }

  return results;
}

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT });
}
