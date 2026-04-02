import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import {
  queryTasksByProject,
  queryRecentlyCompleted,
  queryAllActiveTasks,
  queryAllRecentlyCompleted,
  type NotionTask,
} from "./client.js";
import { renderTasksMarkdown } from "./renderer.js";
import { getAllProjectMappings, getProjectMapping } from "./config.js";
import { commitAndPushFiles } from "../tasks/git-sync.js";

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

/** Sync a single project from Notion to its repo's tasks.md. */
export async function syncProject(projectName: string): Promise<SyncResult> {
  const mapping = getProjectMapping(projectName);
  if (!mapping) {
    return { project: projectName, action: "no-repo", message: "No repo mapping for this project" };
  }

  if (!existsSync(mapping.repoPath)) {
    return { project: projectName, action: "no-repo", message: `Repo path does not exist: ${mapping.repoPath}` };
  }

  const [activeTasks, completedTasks] = await Promise.all([
    queryTasksByProject(projectName),
    queryRecentlyCompleted(projectName),
  ]);

  const markdown = renderTasksMarkdown(projectName, activeTasks, completedTasks);
  const taskFilePath = join(mapping.repoPath, TASK_FILE_REL);

  // Diff check: skip if content matches (ignoring the sync timestamp lines)
  const existing = await readFile(taskFilePath, "utf-8").catch(() => "");
  if (stripSyncTimestamps(existing) === stripSyncTimestamps(markdown)) {
    return { project: projectName, action: "skipped", message: "No task changes" };
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

    const activeTasks = activeByProject.get(projectName) ?? [];
    const completedTasks = completedByProject.get(projectName) ?? [];

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

/** Strip the sync timestamp comment lines so we can compare actual task content. */
function stripSyncTimestamps(content: string): string {
  return content
    .replace(/^<!-- Last sync: .* -->$/m, "")
    .replace(/^> Last synced to repo: .*$/m, "");
}
