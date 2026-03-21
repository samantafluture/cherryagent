import { execFile } from "node:child_process";
import type { PrResult } from "./types.js";

/**
 * Ensure the repo is on main with a clean working tree.
 * Stashes any uncommitted changes to prevent them leaking into voice branches.
 */
export async function ensureCleanMain(repoPath: string): Promise<void> {
  // Stash any uncommitted changes (e.g., tasks.md updates from other commands)
  const status = await git(repoPath, ["status", "--porcelain"]);
  if (status.trim()) {
    await git(repoPath, ["stash", "push", "-m", "voice-agent-pre-run"]);
  }

  // Switch to main and pull latest
  await git(repoPath, ["checkout", "main"]);
  try {
    await git(repoPath, ["pull", "origin", "main"]);
  } catch {
    // Pull may fail if offline — continue with local main
  }
}

/**
 * Create a feature branch, stage specific files, commit, and push.
 * Returns true if there were changes to commit.
 */
export async function createBranchAndPush(opts: {
  repoPath: string;
  branchName: string;
  commitMessage: string;
  changedFiles?: string[];
}): Promise<boolean> {
  const { repoPath, branchName, commitMessage, changedFiles } = opts;

  // Create and switch to feature branch (from clean main)
  await git(repoPath, ["checkout", "-b", branchName]);

  // Stage only the files the agent changed (supports both new and modified files)
  if (changedFiles && changedFiles.length > 0) {
    await git(repoPath, ["add", ...changedFiles]);
  } else {
    // Fallback: stage all changes including untracked files (but not ignored)
    await git(repoPath, ["add", "--all"]);
  }

  // Check if there are staged changes to commit
  const diff = await git(repoPath, ["diff", "--cached", "--name-only"]);
  if (!diff.trim()) {
    // No changes — switch back to main and delete branch
    await git(repoPath, ["checkout", "main"]);
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
  changedFiles?: string[];
}): Promise<boolean> {
  const { repoPath, commitMessage, changedFiles } = opts;

  if (changedFiles && changedFiles.length > 0) {
    await git(repoPath, ["add", ...changedFiles]);
  } else {
    await git(repoPath, ["add", "--all"]);
  }

  const diff = await git(repoPath, ["diff", "--cached", "--name-only"]);
  if (!diff.trim()) return false;

  await git(repoPath, ["commit", "-m", commitMessage]);
  await git(repoPath, ["push"]);

  return true;
}

function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN env var is required for PR operations");
  return token;
}

/**
 * Get the GitHub owner/repo from a git remote URL.
 */
async function getRepoSlug(repoPath: string): Promise<string> {
  const remoteUrl = await git(repoPath, ["remote", "get-url", "origin"]);
  const trimmed = remoteUrl.trim();

  // SSH: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = trimmed.match(/github\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  throw new Error(`Cannot parse GitHub repo from remote URL: ${trimmed}`);
}

async function githubApi(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = getGitHubToken();
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${text}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * Create a draft PR using the GitHub API.
 */
export async function createDraftPr(opts: {
  repoPath: string;
  title: string;
  body: string;
  labels?: string[];
}): Promise<PrResult> {
  const { repoPath, title, body, labels = ["cherryagent", "voice-task"] } = opts;

  try {
    const slug = await getRepoSlug(repoPath);
    const branchName = (await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

    const pr = await githubApi("POST", `/repos/${slug}/pulls`, {
      title,
      body,
      head: branchName,
      base: "main",
      draft: true,
    });

    const prUrl = pr.html_url as string;
    const prNumber = pr.number as number;

    // Try to add labels (non-critical — labels may not exist)
    if (labels.length > 0) {
      try {
        await githubApi("POST", `/repos/${slug}/issues/${prNumber}/labels`, {
          labels,
        });
      } catch {
        // Labels may not exist in the repo — not a blocker
      }
    }

    return { success: true, prUrl, prNumber };
  } catch (err) {
    return {
      success: false,
      prUrl: null,
      prNumber: null,
      error: err instanceof Error ? err.message : String(err),
    };
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
    const slug = await getRepoSlug(opts.repoPath);

    await githubApi("PUT", `/repos/${slug}/pulls/${opts.prNumber}/merge`, {
      merge_method: "squash",
    });

    // Delete the branch if requested
    if (opts.deleteBranch !== false) {
      try {
        const pr = await githubApi("GET", `/repos/${slug}/pulls/${opts.prNumber}`);
        const branchRef = (pr.head as Record<string, unknown>).ref as string;
        await fetch(`https://api.github.com/repos/${slug}/git/refs/heads/${branchRef}`, {
          method: "DELETE",
          headers: {
            Authorization: `token ${getGitHubToken()}`,
            Accept: "application/vnd.github.v3+json",
          },
        });
      } catch {
        // Branch deletion is best-effort
      }
    }

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
    const slug = await getRepoSlug(opts.repoPath);

    // Close the PR
    await githubApi("PATCH", `/repos/${slug}/pulls/${opts.prNumber}`, {
      state: "closed",
    });

    // Delete remote branch
    try {
      await fetch(
        `https://api.github.com/repos/${slug}/git/refs/heads/${opts.branchName}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `token ${getGitHubToken()}`,
            Accept: "application/vnd.github.v3+json",
          },
        },
      );
    } catch {
      // Best-effort branch deletion
    }

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

/**
 * Check if a branch exists on the remote.
 */
export async function remoteBranchExists(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  try {
    await git(repoPath, ["ls-remote", "--exit-code", "origin", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}
