import { readFileSync, writeFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import type { Task, TaskFile, Priority, Size, TaskStatus } from "./types.js";
import { parseTaskFile } from "./parser.js";
import { serializeTaskFile } from "./serializer.js";
import { createHash } from "crypto";

export function loadTaskFile(filePath: string): TaskFile {
  const content = readFileSync(filePath, "utf-8");
  // If file is empty or corrupted, return a minimal structure instead of
  // parsing garbage that could later be saved and committed
  if (!content.trim() || !content.includes("# Project:")) {
    const slug = filePath.split("/").at(-3) ?? "Unknown";
    return {
      projectName: slug,
      lastSyncedToRepo: "—",
      lastAgentUpdate: "—",
      sections: {
        activeP0: { tasks: [], freeformLines: [] },
        activeP1: { tasks: [], freeformLines: [] },
        activeP2: { tasks: [], freeformLines: [] },
        blocked: { tasks: [], freeformLines: [] },
        completed: { tasks: [], freeformLines: [] },
        notes: [],
      },
    };
  }
  return parseTaskFile(content);
}

export function saveTaskFile(filePath: string, file: TaskFile): void {
  const content = serializeTaskFile(file);

  // Guard: never write empty or header-less content (prevents corruption on crash)
  if (!content.includes("# Project:")) {
    throw new Error(`Refusing to save corrupted task file to ${filePath}: missing project header`);
  }

  // Atomic write: write to temp file, then rename (rename is atomic on POSIX)
  const tmpPath = join(dirname(filePath), `.tasks.md.tmp.${process.pid}`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

export function addTask(
  file: TaskFile,
  opts: {
    title: string;
    priority?: Priority;
    size?: Size;
    tags?: string[];
    manual?: boolean;
  }
): Task {
  const priority = opts.priority ?? "P2";
  const task: Task = {
    id: createHash("sha256").update(opts.title).digest("hex").substring(0, 8),
    title: opts.title,
    checkbox: false,
    size: opts.size,
    tags: opts.tags ?? [],
    priority,
    status: "active",
    manual: opts.manual ?? false,
    subtasks: [],
    notes: [],
  };

  const section = getSectionForPriority(file, priority);
  section.tasks.push(task);
  return task;
}

export function updateTaskStatus(file: TaskFile, taskId: string, newStatus: TaskStatus): Task | null {
  const task = findTask(file, taskId);
  if (!task) return null;

  // Remove from current location
  removeTaskFromAllSections(file, taskId);

  task.status = newStatus;

  if (newStatus === "done") {
    task.checkbox = true;
    task.completedDate = new Date().toISOString().split("T")[0];
    file.sections.completed.tasks.unshift(task);
  } else if (newStatus === "blocked") {
    task.checkbox = false;
    file.sections.blocked.tasks.push(task);
  } else {
    // "active" or "wip" — stays in priority section
    task.checkbox = false;
    const section = getSectionForPriority(file, task.priority);
    section.tasks.push(task);
  }

  return task;
}

export function deleteTask(file: TaskFile, taskId: string): boolean {
  return removeTaskFromAllSections(file, taskId);
}

export function reorderTask(file: TaskFile, taskId: string, direction: "up" | "down"): boolean {
  const prioritySections = [
    file.sections.activeP0,
    file.sections.activeP1,
    file.sections.activeP2,
  ];
  const priorities: Priority[] = ["P0", "P1", "P2"];

  // Check priority sections first
  for (let si = 0; si < prioritySections.length; si++) {
    const section = prioritySections[si];
    const idx = section.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) continue;

    if (direction === "up") {
      if (idx > 0) {
        // Swap within section
        [section.tasks[idx], section.tasks[idx - 1]] = [section.tasks[idx - 1], section.tasks[idx]];
        return true;
      }
      // At top of section — try to move to previous priority section
      if (si === 0) return false; // already at absolute top
      const prevSection = prioritySections[si - 1];
      const [task] = section.tasks.splice(idx, 1);
      task.priority = priorities[si - 1];
      prevSection.tasks.push(task);
      return true;
    } else {
      if (idx < section.tasks.length - 1) {
        // Swap within section
        [section.tasks[idx], section.tasks[idx + 1]] = [section.tasks[idx + 1], section.tasks[idx]];
        return true;
      }
      // At bottom of section — try to move to next priority section
      if (si === prioritySections.length - 1) return false; // already at absolute bottom
      const nextSection = prioritySections[si + 1];
      const [task] = section.tasks.splice(idx, 1);
      task.priority = priorities[si + 1];
      nextSection.tasks.unshift(task);
      return true;
    }
  }

  // Blocked tasks: reorder among themselves only, no cross-section
  const blocked = file.sections.blocked;
  const bIdx = blocked.tasks.findIndex((t) => t.id === taskId);
  if (bIdx !== -1) {
    const newIdx = direction === "up" ? bIdx - 1 : bIdx + 1;
    if (newIdx < 0 || newIdx >= blocked.tasks.length) return false;
    [blocked.tasks[bIdx], blocked.tasks[newIdx]] = [blocked.tasks[newIdx], blocked.tasks[bIdx]];
    return true;
  }

  return false;
}

export function changeTaskPriority(file: TaskFile, taskId: string, newPriority: Priority): boolean {
  const task = findTask(file, taskId);
  if (!task) return false;
  if (task.status === "blocked" || task.status === "done") return false;
  if (task.priority === newPriority) return false;

  removeTaskFromAllSections(file, taskId);
  task.priority = newPriority;
  const section = getSectionForPriority(file, newPriority);
  section.tasks.push(task);
  return true;
}

export function addTaskNote(file: TaskFile, taskId: string, note: string): boolean {
  const task = findTask(file, taskId);
  if (!task) return false;
  task.notes.push(note);
  return true;
}

export function editTaskTitle(file: TaskFile, taskId: string, newTitle: string): boolean {
  const task = findTask(file, taskId);
  if (!task) return false;
  task.title = newTitle;
  // Regenerate ID based on new title
  task.id = createHash("sha256").update(newTitle).digest("hex").substring(0, 8);
  return true;
}

export function findTask(file: TaskFile, taskId: string): Task | null {
  for (const section of allSections(file)) {
    const task = section.tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return null;
}

export function getAllTasks(file: TaskFile): Task[] {
  const tasks: Task[] = [];
  for (const section of allSections(file)) {
    tasks.push(...section.tasks);
  }
  return tasks;
}

export function getActiveTasks(file: TaskFile): Task[] {
  return getAllTasks(file).filter((t) => t.status === "active" || t.status === "wip");
}

// --- helpers ---

function getSectionForPriority(file: TaskFile, priority: Priority) {
  switch (priority) {
    case "P0": return file.sections.activeP0;
    case "P1": return file.sections.activeP1;
    case "P2": return file.sections.activeP2;
  }
}

function allSections(file: TaskFile) {
  return [
    file.sections.activeP0,
    file.sections.activeP1,
    file.sections.activeP2,
    file.sections.blocked,
    file.sections.completed,
  ];
}

function removeTaskFromAllSections(file: TaskFile, taskId: string): boolean {
  for (const section of allSections(file)) {
    const idx = section.tasks.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      section.tasks.splice(idx, 1);
      return true;
    }
  }
  return false;
}
