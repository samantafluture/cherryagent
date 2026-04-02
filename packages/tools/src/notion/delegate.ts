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

const execFileAsync = promisify(execFile);

const CLAUDE_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB
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

/** Build prompt for Claude Code from task metadata. */
function buildPrompt(task: NotionTask): string {
  const lines: string[] = [];

  lines.push(`Task: ${task.title}`);
  if (task.type) lines.push(`Type: ${task.type}`);
  if (task.filePath) lines.push(`Focus on: ${task.filePath}`);
  if (task.branch) lines.push(`Work on branch: ${task.branch}`);
  lines.push("");
  lines.push("Read CLAUDE.md first. Follow existing conventions.");
  lines.push("Commit your changes with a descriptive message.");
  lines.push("Keep your response concise — summarize what you did.");

  return lines.join("\n");
}

/** Extract a one-line summary from Claude Code output. */
function extractSummary(output: string): string {
  const lines = output.trim().split("\n").filter((l) => l.trim());
  // Take the last non-empty line as summary (Claude often summarizes at the end)
  const summary = lines[lines.length - 1] ?? "Task completed";
  return summary.slice(0, 200);
}

/** Execute a single delegated task end-to-end. */
export async function executeDelegatedTask(
  task: NotionTask,
  opts?: DelegationPollerOpts,
): Promise<DelegationResult> {
  const mapping = getProjectMapping(task.project);
  if (!mapping) {
    return {
      pageId: task.pageId,
      task: task.title,
      project: task.project,
      action: "skipped",
      message: `No repo mapping for project: ${task.project}`,
    };
  }

  if (!existsSync(mapping.repoPath)) {
    return {
      pageId: task.pageId,
      task: task.title,
      project: task.project,
      action: "skipped",
      message: `Repo path does not exist: ${mapping.repoPath}`,
    };
  }

  // 1. Triage: check if task is small enough for a single session
  try {
    const triage = await triageTask(task);
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

  // 3. Spawn Claude Code
  const prompt = buildPrompt(task);
  try {
    const { stdout } = await execFileAsync("claude", ["-p", prompt], {
      cwd: mapping.repoPath,
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env },
    });

    const output = stdout.trim();
    const summary = extractSummary(output);

    // 3. Mark done in Notion
    await markTaskDone(task.pageId, summary, output);

    // 4. Sync tasks.md for this project
    try {
      await syncProject(task.project);
    } catch {
      // Non-fatal: sync failure doesn't invalidate the task execution
    }

    const result: DelegationResult = {
      pageId: task.pageId,
      task: task.title,
      project: task.project,
      action: "completed",
      message: summary,
    };

    opts?.onComplete?.(result);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const errMsg = error.message.slice(0, 500);

    // 5. Mark failed in Notion
    try {
      await markTaskFailed(task.pageId, errMsg);
    } catch {
      // Best effort — if Notion update fails too, we still report via Telegram
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
