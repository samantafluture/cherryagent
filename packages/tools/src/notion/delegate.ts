import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { type NotionTask, queryAllActiveTasks } from "./client.js";
import { getProjectMapping } from "./config.js";
import {
  updateNotionTaskStatus,
  markTaskDone,
  markTaskFailed,
  createSubtasksInNotion,
} from "./writer.js";
import { triageTask } from "./triage.js";
import { syncProject } from "./sync.js";
import { runAgent } from "./agent.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000;

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const POLL_OFFSET_MS = 60 * 1000; // 1 minute offset from sync scheduler
const QUIET_HOURS_START = 0;
const QUIET_HOURS_END = 6;

export interface DelegationResult {
  pageId: string;
  task: string;
  project: string;
  action: "completed" | "failed" | "skipped";
  message: string;
  prUrl?: string;
}

export interface DelegationPollerOpts {
  onStart?: (task: NotionTask) => void;
  onComplete?: (result: DelegationResult) => void;
  onError?: (task: NotionTask, error: Error) => void;
}

let isRunning = false;

function isDuringQuietHours(): boolean {
  const hour = new Date().getHours();
  return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

/** Query Notion for tasks with Delegate checked + Status = Not started. */
export async function pollDelegatedTasks(): Promise<NotionTask[]> {
  const allActive = await queryAllActiveTasks();
  return allActive.filter(
    (t) => t.delegated && t.status === "Not started",
  );
}

/** Build prompt for Claude Code from task metadata, using enriched prompt from triage if available. */
function buildPrompt(task: NotionTask, enrichedPrompt?: string): string {
  const lines: string[] = [];

  if (enrichedPrompt) {
    // Use Gemini's enriched prompt as the primary instruction
    lines.push(enrichedPrompt);
    lines.push("");
    lines.push("Additional instructions:");
  } else {
    // Fallback: basic prompt from task metadata
    lines.push(`Task: ${task.title}`);
    if (task.type) lines.push(`Type: ${task.type}`);
    if (task.filePath) lines.push(`Focus on: ${task.filePath}`);
    lines.push("");
    lines.push("Instructions:");
    lines.push("- Read CLAUDE.md first if it exists. Follow existing conventions.");
  }

  lines.push("- Do NOT push or create branches. Just make changes and commit locally.");
  lines.push("- Be focused and efficient. Go straight to the relevant files.");
  lines.push("- Keep your response concise — summarize what you changed in 2-3 sentences.");

  return lines.join("\n");
}

/** Generate a branch name from the task title. */
function generateBranchName(task: NotionTask): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const id = task.pageId.replace(/-/g, "").slice(0, 6);
  return `delegate/${slug}-${id}`;
}

/** Extract a one-line summary from Claude Code output. */
function extractSummary(output: string): string {
  const lines = output.trim().split("\n").filter((l) => l.trim());
  const summary = lines[lines.length - 1] ?? "Task completed";
  return summary.slice(0, 200);
}

// --- Git helpers ---

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT });
  return stdout.trim();
}

async function ensureCleanMain(repoPath: string): Promise<void> {
  // Stash any uncommitted changes
  await git(repoPath, ["stash", "push", "-m", "delegate-pre-run"]).catch(() => {});
  // Switch to main (try main, then master)
  try {
    await git(repoPath, ["checkout", "main"]);
  } catch {
    await git(repoPath, ["checkout", "master"]).catch(() => {});
  }
  // Pull latest
  await git(repoPath, ["pull"]).catch(() => {});
}

async function createBranchAndCheckout(repoPath: string, branchName: string): Promise<void> {
  await git(repoPath, ["checkout", "-b", branchName]);
}

async function pushBranchAndCreatePr(
  repoPath: string,
  branchName: string,
  title: string,
  body: string,
): Promise<{ prUrl: string | null }> {
  // Push the branch
  await git(repoPath, ["push", "-u", "origin", branchName]);

  // Create draft PR via GitHub API
  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    return { prUrl: null };
  }

  // Extract owner/repo from remote URL
  const remoteUrl = await git(repoPath, ["remote", "get-url", "origin"]);
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!match) return { prUrl: null };
  const repoSlug = match[1];

  // Determine base branch
  const baseBranch = await git(repoPath, ["rev-parse", "--abbrev-ref", "origin/HEAD"])
    .then((ref) => ref.replace("origin/", ""))
    .catch(() => "main");

  try {
    const response = await fetch(`https://api.github.com/repos/${repoSlug}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
      },
      body: JSON.stringify({
        title,
        body,
        head: branchName,
        base: baseBranch,
        draft: true,
      }),
    });

    if (response.ok) {
      const pr = await response.json() as { html_url: string };
      return { prUrl: pr.html_url };
    }
    return { prUrl: null };
  } catch {
    return { prUrl: null };
  }
}

async function cleanupBranch(repoPath: string, branchName: string): Promise<void> {
  // Return to main regardless of what happened
  try {
    await git(repoPath, ["checkout", "main"]);
  } catch {
    await git(repoPath, ["checkout", "master"]).catch(() => {});
  }
  // Delete the feature branch locally (remote copy stays for the PR)
  await git(repoPath, ["branch", "-D", branchName]).catch(() => {});
}

const PROJECTS_BASE = process.env["PROJECTS_BASE"] ?? "/home/sam/apps";

/** Execute a single delegated task end-to-end. */
export async function executeDelegatedTask(
  task: NotionTask,
  opts?: DelegationPollerOpts,
): Promise<DelegationResult> {
  const mapping = getProjectMapping(task.project);
  const repoPath = mapping?.repoPath && existsSync(mapping.repoPath)
    ? mapping.repoPath
    : PROJECTS_BASE;

  // 1. Triage: check if task is small enough + get enriched prompt
  let enrichedPrompt = "";
  try {
    const triage = await triageTask(task);
    enrichedPrompt = triage.enrichedPrompt;

    if (!triage.canExecute && triage.subtasks.length > 0) {
      await createSubtasksInNotion(task, triage.subtasks, triage.reason);

      try {
        await syncProject(task.project);
      } catch {
        // Non-fatal
      }

      const result: DelegationResult = {
        pageId: task.pageId,
        task: task.title,
        project: task.project,
        action: "completed",
        message: `Decomposed into ${triage.subtasks.length} subtasks: ${triage.reason}`,
      };
      opts?.onComplete?.(result);
      return result;
    }
  } catch {
    // Triage failed — proceed with execution anyway
  }

  // 2. Mark as in progress
  try {
    await updateNotionTaskStatus(task.pageId, "In progress");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      pageId: task.pageId,
      task: task.title,
      project: task.project,
      action: "failed",
      message: `Failed to update Notion status: ${message}`,
    };
  }

  opts?.onStart?.(task);

  // 3. Create a feature branch
  const branchName = generateBranchName(task);
  try {
    await ensureCleanMain(repoPath);
    await createBranchAndCheckout(repoPath, branchName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { await markTaskFailed(task.pageId, `Git branch setup failed: ${message}`); } catch { /* best effort */ }
    return {
      pageId: task.pageId,
      task: task.title,
      project: task.project,
      action: "failed",
      message: `Git branch setup failed: ${message}`,
    };
  }

  // 4. Run agent on the feature branch
  const prompt = buildPrompt(task, enrichedPrompt);
  try {
    const { output: rawOutput } = await runAgent(prompt, repoPath);
    const output = rawOutput.trim();
    const summary = extractSummary(output);

    // 5. Push branch and create draft PR
    let prUrl: string | null = null;
    try {
      const prTitle = `[delegate] ${task.title}`;
      const prBody = [
        `## Task`,
        task.title,
        task.type ? `**Type:** ${task.type}` : "",
        task.filePath ? `**Files:** ${task.filePath}` : "",
        "",
        "## Claude Code Output",
        output.length > 3000 ? output.slice(-3000) : output,
        "",
        `> Auto-delegated from Notion by CherryAgent`,
      ].filter(Boolean).join("\n");

      const pr = await pushBranchAndCreatePr(repoPath, branchName, prTitle, prBody);
      prUrl = pr.prUrl;
    } catch (err) {
      console.error(`[delegate] PR creation failed for ${task.title}:`, err);
    }

    // 6. Clean up: return to main
    await cleanupBranch(repoPath, branchName);

    // 7. Update Notion
    const resultMsg = prUrl ? `${summary}\n\nPR: ${prUrl}` : summary;
    await markTaskDone(task.pageId, resultMsg, output);

    // 8. Sync tasks.md
    try {
      await syncProject(task.project);
    } catch {
      // Non-fatal
    }

    const result: DelegationResult = {
      pageId: task.pageId,
      task: task.title,
      project: task.project,
      action: "completed",
      message: resultMsg,
      prUrl: prUrl ?? undefined,
    };

    opts?.onComplete?.(result);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const errMsg = error.message.slice(0, 500);

    // Clean up branch on failure too
    await cleanupBranch(repoPath, branchName).catch(() => {});

    try {
      await markTaskFailed(task.pageId, errMsg);
    } catch {
      // Best effort
    }

    try {
      await syncProject(task.project);
    } catch {
      // Non-fatal
    }

    const result: DelegationResult = {
      pageId: task.pageId,
      task: task.title,
      project: task.project,
      action: "failed",
      message: errMsg,
    };

    opts?.onError?.(task, error);
    opts?.onComplete?.(result);
    return result;
  }
}

/** Process all delegated tasks sequentially (max 1 concurrent). */
export async function processDelegatedTasks(
  opts?: DelegationPollerOpts,
): Promise<DelegationResult[]> {
  if (isRunning) {
    return [{ pageId: "", task: "", project: "", action: "skipped", message: "Delegation already running" }];
  }

  isRunning = true;
  try {
    const tasks = await pollDelegatedTasks();
    if (tasks.length === 0) return [];

    const results: DelegationResult[] = [];
    for (const task of tasks) {
      const result = await executeDelegatedTask(task, opts);
      results.push(result);
    }
    return results;
  } finally {
    isRunning = false;
  }
}

/** Start periodic delegation polling. Returns interval handle. */
export function startDelegationPoller(
  opts?: DelegationPollerOpts,
): ReturnType<typeof setTimeout> {
  const run = async () => {
    if (isDuringQuietHours()) return;

    try {
      await processDelegatedTasks(opts);
    } catch (err) {
      console.error("[delegate] Poll failed:", err);
    }
  };

  // Offset by 1 minute from sync scheduler to avoid overlap
  const initialDelay = setTimeout(() => {
    run().catch((err) => console.error("[delegate] Initial run failed:", err));

    // Then run on interval
    setInterval(() => {
      run().catch((err) => console.error("[delegate] Interval run failed:", err));
    }, POLL_INTERVAL_MS);
  }, POLL_OFFSET_MS);

  return initialDelay;
}
