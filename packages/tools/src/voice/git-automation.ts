import { execFile } from "node:child_process";
import type { PrResult } from "./types.js";

/**
 * Create a feature branch, stage, commit, and push.
 * Returns true if there were changes to commit.
 */
export async function createBranchAndPush(opts: {
  repoPath: string;
  branchName: string;
  commitMessage: string;
}): Promise<boolean> {
  const { repoPath, branchName, commitMessage } = opts;

  // Create and switch to feature branch
  await git(repoPath, ["checkout", "-b", branchName]);

  // Stage all changes
  await git(repoPath, ["add", "-A"]);

  // Check if there are changes to commit
  const status = await git(repoPath, ["status", "--porcelain"]);
  if (!status.trim()) {
    // No changes — switch back to previous branch and delete
    await git(repoPath, ["checkout", "-"]);
    await git(repoPath, ["branch", "-D", branchName]);
    return false;
  }

  // Commit and push
  await git(repoPath, ["commit", "-m", commitMessage]);
  await git(repoPath, ["push", "-u", "origin", branchName]);

  return true;
}

/**
 * Push additional commits on an existing branch.
 */
export async function pushExistingBranch(opts: {
  repoPath: string;
  commitMessage: string;
}): Promise<boolean> {
  const { repoPath, commitMessage } = opts;

  await git(repoPath, ["add", "-A"]);

  const status = await git(repoPath, ["status", "--porcelain"]);
  if (!status.trim()) return false;

  await git(repoPath, ["commit", "-m", commitMessage]);
  await git(repoPath, ["push"]);

  return true;
}

/**
 * Create a draft PR using the GitHub CLI (gh).
 */
export async function createDraftPr(opts: {
  repoPath: string;
  title: string;
  body: string;
  labels?: string[];
}): Promise<PrResult> {
  const { repoPath, title, body, labels = ["cherryagent", "voice-task"] } = opts;

  try {
    const args = [
      "pr", "create",
      "--title", title,
      "--body", body,
      "--draft",
    ];

    for (const label of labels) {
      args.push("--label", label);
    }

    const output = await execInDir(repoPath, "gh", args);

    // gh pr create outputs the PR URL
    const prUrl = output.trim();
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;

    return { success: true, prUrl, prNumber };
  } catch (err) {
    // Labels might not exist — retry without labels
    try {
      const output = await execInDir(repoPath, "gh", [
        "pr", "create",
        "--title", title,
        "--body", body,
        "--draft",
      ]);

      const prUrl = output.trim();
      const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;

      return { success: true, prUrl, prNumber };
    } catch (retryErr) {
      return {
        success: false,
        prUrl: null,
        prNumber: null,
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      };
    }
  }
}

/**
 * Merge a PR by number.
 */
export async function mergePr(opts: {
  repoPath: string;
  prNumber: number;
  deleteBranch?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const args = ["pr", "merge", String(opts.prNumber), "--squash"];
    if (opts.deleteBranch !== false) {
      args.push("--delete-branch");
    }
    await execInDir(opts.repoPath, "gh", args);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Close a PR and delete the branch.
 */
export async function closePr(opts: {
  repoPath: string;
  prNumber: number;
  branchName: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    await execInDir(opts.repoPath, "gh", [
      "pr", "close", String(opts.prNumber), "--delete-branch",
    ]);

    // Switch back to main and clean up local branch
    await git(opts.repoPath, ["checkout", "main"]);
    try {
      await git(opts.repoPath, ["branch", "-D", opts.branchName]);
    } catch {
      // Branch might already be deleted
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return execInDir(cwd, "git", args);
}

function execInDir(cwd: string, cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 30_000 }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}
