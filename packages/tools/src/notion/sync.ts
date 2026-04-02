import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  queryTasksByProject,
  queryRecentlyCompleted,
  queryAllActiveTasks,
  queryAllRecentlyCompleted,
  type NotionTask,
} from "./client.js";
import { getClient } from "./client.js";
import { renderTasksMarkdown } from "./renderer.js";
import { getAllProjectMappings, getProjectMapping } from "./config.js";
import { commitAndPushFiles } from "../tasks/git-sync.js";
import { parseTaskFile } from "../tasks/parser.js";
import type { Task } from "../tasks/types.js";

export interface SyncResult {
  project: string;
  action: "synced" | "skipped" | "error" | "no-repo";
  message: string;
}

export interface NotionSyncSchedulerOpts {
  intervalMs?: number;
  onError?: (project: string, error: Error) => void;
}

const TASK_FILE_REL = ".claude/tasks.md";
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const QUIET_HOURS_START = 0;
const QUIET_HOURS_END = 6;

function isDuringQuietHours(): boolean {
  const hour = new Date().getHours();
  return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

/**
 * Promote tasks found in tasks.md that don't exist in Notion.
 * This handles the case where Claude Code agents add tasks via /cherrytasks.
 * Matching is by normalized title (lowercase, trimmed).
 */
async function promoteLocalTasks(
  projectName: string,
  repoPath: string,
  notionTasks: NotionTask[],
): Promise<number> {
  const taskFilePath = join(repoPath, TASK_FILE_REL);
  const existing = await readFile(taskFilePath, "utf-8").catch(() => "");
  if (!existing || !existing.includes("# Project:")) return 0;

  // Parse the local tasks.md
  const localFile = parseTaskFile(existing);
  const localTasks: Task[] = [
    ...localFile.sections.activeP0.tasks,
    ...localFile.sections.activeP1.tasks,
    ...localFile.sections.activeP2.tasks,
    ...localFile.sections.blocked.tasks,
  ].filter((t) => !t.checkbox); // only active tasks

  if (localTasks.length === 0) return 0;

  // Build a set of normalized Notion task titles for matching
  const notionTitles = new Set(
    notionTasks.map((t) => t.title.toLowerCase().trim()),
  );

  // Find tasks in tasks.md that aren't in Notion
  const newTasks = localTasks.filter(
    (t) => !notionTitles.has(t.title.toLowerCase().trim()),
  );

  if (newTasks.length === 0) return 0;

  // Create them in Notion
  const client = getClient();
  const dataSourceId = process.env["NOTION_DATA_SOURCE_ID"];
  if (!dataSourceId) return 0;

  const priorityMap: Record<string, string> = {
    P0: "P0 Critical",
    P1: "P1 High",
    P2: "P2 Medium",
  };

  for (const task of newTasks) {
    const properties: Record<string, unknown> = {
      Task: { title: [{ text: { content: task.title } }] },
      Status: { status: { name: task.status === "wip" ? "In progress" : "Not started" } },
      Project: { select: { name: projectName } },
      Priority: { select: { name: priorityMap[task.priority] ?? "P2 Medium" } },
      Owner: { select: { name: "Claude Code" } },
    };

    // Map tags to Type if we recognize one
    const typeTag = task.tags.find((t) =>
      ["feature", "bug", "chore", "research", "infra", "content", "design"].includes(t),
    );
    if (typeTag) {
      properties["Type"] = { select: { name: typeTag.charAt(0).toUpperCase() + typeTag.slice(1) } };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.pages.create({ parent: { data_source_id: dataSourceId }, properties: properties as any });
      console.log(`[notion-sync] Promoted local task to Notion: "${task.title}" (${projectName})`);
    } catch (err) {
      console.error(`[notion-sync] Failed to promote task "${task.title}":`, err);
    }
  }

  return newTasks.length;
}

/** Sync a single project from Notion to its repo's tasks.md. */
export async function syncProject(projectName: string): Promise<SyncResult> {
  const mapping = getProjectMapping(projectName);
  if (!mapping) {
    return { project: projectName, action: "no-repo", message: "No repo mapping for this project" };
  }

  if (!existsSync(mapping.repoPath)) {
    return { project: projectName, action: "no-repo", message: `Repo path does not exist: ${mapping.repoPath}` };
  }

  let [activeTasks, completedTasks] = await Promise.all([
    queryTasksByProject(projectName),
    queryRecentlyCompleted(projectName),
  ]);

  // Reverse sync: promote local tasks.md tasks to Notion before overwriting
  const promoted = await promoteLocalTasks(projectName, mapping.repoPath, activeTasks).catch(() => 0);
  if (promoted > 0) {
    activeTasks = await queryTasksByProject(projectName);
  }

  const markdown = renderTasksMarkdown(projectName, activeTasks, completedTasks);
  const taskFilePath = join(mapping.repoPath, TASK_FILE_REL);

  // Diff check: skip if content matches (ignoring the sync timestamp lines)
  const existing = await readFile(taskFilePath, "utf-8").catch(() => "");
  if (stripSyncTimestamps(existing) === stripSyncTimestamps(markdown)) {
    return { project: projectName, action: "skipped", message: "No task changes" };
  }

  // Skip if repo is on a feature branch (delegation in progress)
  if (!await isOnDefaultBranch(mapping.repoPath)) {
    return { project: projectName, action: "skipped", message: "Repo is on a feature branch — skipping sync" };
  }

  // Write the file
  await mkdir(dirname(taskFilePath), { recursive: true });
  await writeFile(taskFilePath, markdown, "utf-8");

  // Git commit and push
  await commitAndPushFiles(mapping.repoPath, [TASK_FILE_REL], "chore: sync tasks from Notion");

  return { project: projectName, action: "synced", message: `Synced ${activeTasks.length} active + ${completedTasks.length} completed tasks` };
}

/** Sync all projects that have repo mappings. */
export async function syncAllProjects(): Promise<SyncResult[]> {
  // Fetch all tasks in bulk (2 API calls) instead of per-project
  const [allActive, allCompleted] = await Promise.all([
    queryAllActiveTasks(),
    queryAllRecentlyCompleted(),
  ]);

  // Group by project
  const activeByProject = groupByProject(allActive);
  const completedByProject = groupByProject(allCompleted);

  const mappings = getAllProjectMappings();
  const results: SyncResult[] = [];

  for (const [projectName, mapping] of mappings) {
    if (!existsSync(mapping.repoPath)) {
      results.push({ project: projectName, action: "no-repo", message: `Repo path does not exist: ${mapping.repoPath}` });
      continue;
    }

    // Skip if repo is on a feature branch (delegation in progress)
    if (!await isOnDefaultBranch(mapping.repoPath)) {
      results.push({ project: projectName, action: "skipped", message: "Repo on feature branch — skipping" });
      continue;
    }

    let activeTasks = activeByProject.get(projectName) ?? [];
    const completedTasks = completedByProject.get(projectName) ?? [];

    // Reverse sync: promote local tasks.md tasks to Notion before overwriting
    const promoted = await promoteLocalTasks(projectName, mapping.repoPath, activeTasks).catch(() => 0);
    if (promoted > 0) {
      // Re-query Notion to include the newly promoted tasks
      activeTasks = await queryTasksByProject(projectName);
    }

    const markdown = renderTasksMarkdown(projectName, activeTasks, completedTasks);
    const taskFilePath = join(mapping.repoPath, TASK_FILE_REL);

    const existing = await readFile(taskFilePath, "utf-8").catch(() => "");
    if (stripSyncTimestamps(existing) === stripSyncTimestamps(markdown)) {
      results.push({ project: projectName, action: "skipped", message: "No task changes" });
      continue;
    }

    try {
      await mkdir(dirname(taskFilePath), { recursive: true });
      await writeFile(taskFilePath, markdown, "utf-8");
      await commitAndPushFiles(mapping.repoPath, [TASK_FILE_REL], "chore: sync tasks from Notion");
      results.push({
        project: projectName,
        action: "synced",
        message: `Synced ${activeTasks.length} active + ${completedTasks.length} completed tasks`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ project: projectName, action: "error", message });
    }
  }

  return results;
}

/** Start periodic Notion sync. Returns interval handle for cleanup. */
export function startNotionSyncScheduler(
  opts?: NotionSyncSchedulerOpts,
): ReturnType<typeof setInterval> {
  const interval = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;

  const runSync = async () => {
    if (isDuringQuietHours()) return;

    try {
      const results = await syncAllProjects();
      for (const r of results) {
        if (r.action === "error" && opts?.onError) {
          opts.onError(r.project, new Error(r.message));
        }
      }
    } catch (err) {
      console.error("[notion-sync] Full sync failed:", err);
    }
  };

  // Don't run on startup — let the first cron tick handle it
  return setInterval(() => {
    runSync().catch((err) => {
      console.error("[notion-sync] Scheduler error:", err);
    });
  }, interval);
}

function groupByProject(tasks: NotionTask[]): Map<string, NotionTask[]> {
  const map = new Map<string, NotionTask[]>();
  for (const task of tasks) {
    if (!task.project) continue;
    const list = map.get(task.project) ?? [];
    list.push(task);
    map.set(task.project, list);
  }
  return map;
}

/** Check if a repo is on main or master (safe to push to). */
async function isOnDefaultBranch(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
      timeout: 5000,
    });
    const branch = stdout.trim();
    return branch === "main" || branch === "master";
  } catch {
    return false;
  }
}

/** Strip the sync timestamp comment lines so we can compare actual task content. */
function stripSyncTimestamps(content: string): string {
  return content
    .replace(/^<!-- Last sync: .* -->$/m, "")
    .replace(/^> Last synced to repo: .*$/m, "");
}
