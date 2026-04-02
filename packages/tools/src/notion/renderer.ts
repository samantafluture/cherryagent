import { createHash } from "node:crypto";
import { serializeTaskFile } from "../tasks/serializer.js";
import type { Task, TaskFile, Priority, TaskStatus } from "../tasks/types.js";
import type { NotionTask } from "./client.js";

const PRIORITY_MAP: Record<string, Priority> = {
  "P0 Critical": "P0",
  "P1 High": "P1",
  "P2 Medium": "P2",
  "P3 Low": "P2",
};

function mapPriority(notionPriority: string): Priority {
  return PRIORITY_MAP[notionPriority] ?? "P2";
}

function mapStatus(notionStatus: NotionTask["status"]): TaskStatus {
  switch (notionStatus) {
    case "In progress":
      return "wip";
    case "Done":
      return "done";
    default:
      return "active";
  }
}

function taskId(title: string): string {
  return createHash("sha256").update(title).digest("hex").substring(0, 8);
}

function notionTaskToTask(nt: NotionTask): Task {
  const status = mapStatus(nt.status);
  const tags: string[] = [];
  if (nt.type) {
    tags.push(nt.type.toLowerCase());
  }

  return {
    id: taskId(nt.title),
    title: nt.title,
    checkbox: status === "done",
    priority: mapPriority(nt.priority),
    status,
    manual: nt.owner === "Sam",
    tags,
    subtasks: [],
    notes: [],
    completedDate: status === "done" ? extractDate(nt.lastEdited) : undefined,
  };
}

function extractDate(isoString: string): string | undefined {
  if (!isoString) return undefined;
  return isoString.slice(0, 10); // YYYY-MM-DD
}

/** Build a TaskFile from Notion tasks for a given project. */
export function buildTaskFile(
  projectName: string,
  activeTasks: NotionTask[],
  completedTasks: NotionTask[],
): TaskFile {
  const now = new Date().toISOString();

  // Find the most recent edit across all tasks
  const allTasks = [...activeTasks, ...completedTasks];
  const lastEdited = allTasks.reduce((latest, t) => {
    return t.lastEdited > latest ? t.lastEdited : latest;
  }, "");

  const p0Tasks: Task[] = [];
  const p1Tasks: Task[] = [];
  const p2Tasks: Task[] = [];

  for (const nt of activeTasks) {
    const task = notionTaskToTask(nt);
    switch (task.priority) {
      case "P0":
        p0Tasks.push(task);
        break;
      case "P1":
        p1Tasks.push(task);
        break;
      case "P2":
        p2Tasks.push(task);
        break;
    }
  }

  const doneTasks = completedTasks.map(notionTaskToTask);

  return {
    projectName,
    lastSyncedToRepo: now,
    lastAgentUpdate: lastEdited || now,
    sections: {
      activeP0: { tasks: p0Tasks, freeformLines: [] },
      activeP1: { tasks: p1Tasks, freeformLines: [] },
      activeP2: { tasks: p2Tasks, freeformLines: [] },
      blocked: { tasks: [], freeformLines: [] },
      completed: { tasks: doneTasks, freeformLines: [] },
      notes: ["- Check CLAUDE.md for architectural decisions before starting work"],
    },
  };
}

const NOTION_DB_URL = "https://www.notion.so/83f6c83bb3a546cda0739e7f25382a9a";

/** Render a TaskFile to markdown with the auto-generated header. */
export function renderTasksMarkdown(
  projectName: string,
  activeTasks: NotionTask[],
  completedTasks: NotionTask[],
): string {
  const taskFile = buildTaskFile(projectName, activeTasks, completedTasks);
  const body = serializeTaskFile(taskFile);

  const header = [
    "<!-- Auto-generated from Notion. Do not edit manually. -->",
    `<!-- Last sync: ${new Date().toISOString()} -->`,
    `<!-- Source: ${NOTION_DB_URL} -->`,
    "",
  ].join("\n");

  return header + body;
}
