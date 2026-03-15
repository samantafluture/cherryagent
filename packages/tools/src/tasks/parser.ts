import type { Task, Subtask, TaskFile, SectionContent, Priority, Size, TaskStatus } from "./types.js";
import { createHash } from "crypto";

/**
 * Parse a tasks.md file into structured data.
 * Designed for lossless round-trip: parse → serialize → identical output.
 */
export function parseTaskFile(content: string): TaskFile {
  const lines = content.split("\n");

  const projectName = parseProjectName(lines);
  const { lastSyncedToRepo, lastAgentUpdate } = parseMetadata(lines);

  const sectionRanges = findSectionRanges(lines);

  const activeP0 = parsePrioritySection(lines, sectionRanges, "P0");
  const activeP1 = parsePrioritySection(lines, sectionRanges, "P1");
  const activeP2 = parsePrioritySection(lines, sectionRanges, "P2");
  const blocked = parseTopSection(lines, sectionRanges, "blocked");
  const completed = parseTopSection(lines, sectionRanges, "completed");
  const notes = parseNotesSection(lines, sectionRanges);

  return {
    projectName,
    lastSyncedToRepo,
    lastAgentUpdate,
    sections: { activeP0, activeP1, activeP2, blocked, completed, notes },
  };
}

function parseProjectName(lines: string[]): string {
  for (const line of lines) {
    const match = line.match(/^# Project:\s*(.+)$/);
    if (match) return match[1].trim();
  }
  return "Unknown";
}

function parseMetadata(lines: string[]): { lastSyncedToRepo: string; lastAgentUpdate: string } {
  let lastSyncedToRepo = "—";
  let lastAgentUpdate = "—";
  for (const line of lines) {
    const syncMatch = line.match(/^>\s*Last synced to repo:\s*(.+)$/);
    if (syncMatch) lastSyncedToRepo = syncMatch[1].trim();
    const agentMatch = line.match(/^>\s*Last agent update:\s*(.+)$/);
    if (agentMatch) lastAgentUpdate = agentMatch[1].trim();
  }
  return { lastSyncedToRepo, lastAgentUpdate };
}

interface SectionRange {
  start: number;
  end: number;
}

interface SectionRanges {
  activeSprint?: SectionRange;
  p0?: SectionRange;
  p1?: SectionRange;
  p2?: SectionRange;
  blocked?: SectionRange;
  completed?: SectionRange;
  notes?: SectionRange;
}

function findSectionRanges(lines: string[]): SectionRanges {
  const ranges: SectionRanges = {};

  // Find ## level sections
  const h2Indices: { name: string; start: number }[] = [];
  const h3Indices: { name: string; start: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const h2Match = lines[i].match(/^## (.+)$/);
    if (h2Match) {
      h2Indices.push({ name: h2Match[1].trim(), start: i });
    }
    const h3Match = lines[i].match(/^### (.+)$/);
    if (h3Match) {
      h3Indices.push({ name: h3Match[1].trim(), start: i });
    }
  }

  // Map h2 sections
  for (let i = 0; i < h2Indices.length; i++) {
    const section = h2Indices[i];
    const end = i + 1 < h2Indices.length ? h2Indices[i + 1].start : lines.length;
    const name = section.name.toLowerCase();

    if (name.includes("active sprint")) {
      ranges.activeSprint = { start: section.start, end };
    } else if (name.includes("blocked")) {
      ranges.blocked = { start: section.start + 1, end };
    } else if (name.includes("completed")) {
      ranges.completed = { start: section.start + 1, end };
    } else if (name === "notes") {
      ranges.notes = { start: section.start + 1, end };
    }
  }

  // Map h3 priority sections within Active Sprint
  if (ranges.activeSprint) {
    const sprintH3s = h3Indices.filter(
      (h3) => h3.start > ranges.activeSprint!.start && h3.start < ranges.activeSprint!.end
    );
    for (let i = 0; i < sprintH3s.length; i++) {
      const section = sprintH3s[i];
      const end = i + 1 < sprintH3s.length ? sprintH3s[i + 1].start : ranges.activeSprint!.end;
      const name = section.name;

      if (name.startsWith("P0")) {
        ranges.p0 = { start: section.start + 1, end };
      } else if (name.startsWith("P1")) {
        ranges.p1 = { start: section.start + 1, end };
      } else if (name.startsWith("P2")) {
        ranges.p2 = { start: section.start + 1, end };
      }
    }
  }

  return ranges;
}

function parsePrioritySection(
  lines: string[],
  ranges: SectionRanges,
  priority: Priority
): SectionContent {
  const key = priority.toLowerCase() as "p0" | "p1" | "p2";
  const range = ranges[key];
  if (!range) return { tasks: [], freeformLines: [] };

  const status: TaskStatus = "active";
  return parseSectionLines(lines, range.start, range.end, priority, status);
}

function parseTopSection(
  lines: string[],
  ranges: SectionRanges,
  section: "blocked" | "completed"
): SectionContent {
  const range = ranges[section];
  if (!range) return { tasks: [], freeformLines: [] };

  const status: TaskStatus = section === "blocked" ? "blocked" : "done";
  // Tasks in these sections don't have a priority subsection, default to P2
  return parseSectionLines(lines, range.start, range.end, "P2", status);
}

function parseSectionLines(
  lines: string[],
  start: number,
  end: number,
  defaultPriority: Priority,
  defaultStatus: TaskStatus
): SectionContent {
  const tasks: Task[] = [];
  const freeformLines: string[] = [];
  let currentTask: Task | null = null;

  for (let i = start; i < end; i++) {
    const line = lines[i];

    // Top-level task: starts with "- ["
    const taskMatch = line.match(/^- \[([ x])\] (.+)$/);
    if (taskMatch) {
      if (currentTask) tasks.push(currentTask);
      currentTask = parseTaskLine(taskMatch[1] === "x", taskMatch[2], defaultPriority, defaultStatus);
      continue;
    }

    // Subtask: starts with "  - ["
    const subtaskMatch = line.match(/^  - \[([ x])\] (.+)$/);
    if (subtaskMatch && currentTask) {
      currentTask.subtasks.push({
        title: subtaskMatch[2].trim(),
        checkbox: subtaskMatch[1] === "x",
      });
      continue;
    }

    // Note line under a task: starts with "  > "
    const noteMatch = line.match(/^  > (.+)$/);
    if (noteMatch && currentTask) {
      currentTask.notes.push(noteMatch[1]);
      continue;
    }

    // Empty line or freeform text
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      freeformLines.push(trimmed);
    }
  }

  if (currentTask) tasks.push(currentTask);
  return { tasks, freeformLines };
}

function parseTaskLine(
  checked: boolean,
  raw: string,
  defaultPriority: Priority,
  defaultStatus: TaskStatus
): Task {
  let title = raw;
  let size: Size | undefined;
  const tags: string[] = [];
  let completedDate: string | undefined;
  let blockedReason: string | undefined;
  let manual = false;

  // Extract size: `[S]`, `[M]`, `[L]`
  const sizeMatch = title.match(/`\[(S|M|L)\]`/);
  if (sizeMatch) {
    size = sizeMatch[1] as Size;
    title = title.replace(sizeMatch[0], "").trim();
  }

  // Extract tags: #word
  const tagMatches = title.matchAll(/#(\w+)/g);
  for (const m of tagMatches) {
    tags.push(m[1]);
  }
  title = title.replace(/#\w+/g, "").trim();

  // Extract completed date: ✅ YYYY-MM-DD
  const dateMatch = title.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    completedDate = dateMatch[1];
    title = title.replace(dateMatch[0], "").trim();
  }

  // Extract blocked reason: 🔴 blocked: <reason>
  const blockedMatch = title.match(/🔴\s*blocked:\s*(.+)$/);
  if (blockedMatch) {
    blockedReason = blockedMatch[1].trim();
    title = title.replace(blockedMatch[0], "").trim();
  }

  // Extract manual flag: 👤 manual
  if (title.includes("👤 manual")) {
    manual = true;
    title = title.replace("👤 manual", "").trim();
  } else if (title.includes("👤manual")) {
    manual = true;
    title = title.replace("👤manual", "").trim();
  }

  // Clean up trailing/leading dashes from removals
  title = title.replace(/\s+—\s*$/, "").replace(/^\s*—\s+/, "").trim();
  // Clean up double spaces
  title = title.replace(/\s{2,}/g, " ").trim();

  // Determine effective status
  let status = defaultStatus;
  if (blockedReason) status = "blocked";
  if (checked) status = "done";

  const id = generateTaskId(title);

  return {
    id,
    title,
    checkbox: checked,
    size,
    tags,
    priority: defaultPriority,
    status,
    completedDate,
    blockedReason,
    manual,
    subtasks: [],
    notes: [],
  };
}

function generateTaskId(title: string): string {
  const hash = createHash("sha256").update(title).digest("hex");
  return hash.substring(0, 8);
}

function parseNotesSection(lines: string[], ranges: SectionRanges): string[] {
  const range = ranges.notes;
  if (!range) return [];

  const notes: string[] = [];
  for (let i = range.start; i < range.end; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      notes.push(trimmed);
    }
  }
  return notes;
}
