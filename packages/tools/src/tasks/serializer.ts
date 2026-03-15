import type { TaskFile, SectionContent, Task } from "./types.js";

/**
 * Serialize a TaskFile back to markdown.
 * Designed for lossless round-trip with the parser.
 */
export function serializeTaskFile(file: TaskFile): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Project: ${file.projectName}`);
  lines.push("");
  lines.push(`> Last synced to repo: ${file.lastSyncedToRepo}`);
  lines.push(`> Last agent update: ${file.lastAgentUpdate}`);
  lines.push("");

  // Active Sprint
  lines.push("## Active Sprint");
  lines.push("");
  lines.push("### P0 — Must do now");
  serializeSectionContent(lines, file.sections.activeP0);
  lines.push("");
  lines.push("### P1 — Should do this week");
  serializeSectionContent(lines, file.sections.activeP1);
  lines.push("");
  lines.push("### P2 — Nice to have");
  serializeSectionContent(lines, file.sections.activeP2);
  lines.push("");

  // Blocked
  lines.push("## Blocked");
  serializeSectionContent(lines, file.sections.blocked);
  lines.push("");

  // Completed
  lines.push("## Completed (recent)");
  serializeSectionContent(lines, file.sections.completed);
  lines.push("");

  // Notes
  lines.push("## Notes");
  for (const note of file.sections.notes) {
    lines.push(note);
  }
  lines.push("");

  return lines.join("\n");
}

function serializeSectionContent(lines: string[], section: SectionContent): void {
  // Freeform lines first (e.g., "All P0 tasks completed.")
  for (const freeform of section.freeformLines) {
    lines.push(freeform);
  }

  for (const task of section.tasks) {
    lines.push(serializeTask(task));

    for (const subtask of task.subtasks) {
      const check = subtask.checkbox ? "x" : " ";
      lines.push(`  - [${check}] ${subtask.title}`);
    }

    for (const note of task.notes) {
      lines.push(`  > ${note}`);
    }
  }
}

function serializeTask(task: Task): string {
  const parts: string[] = [];

  const check = task.checkbox ? "x" : " ";
  parts.push(`- [${check}]`);

  parts.push(task.title);

  if (task.size) {
    parts.push(`\`[${task.size}]\``);
  }

  for (const tag of task.tags) {
    parts.push(`#${tag}`);
  }

  if (task.manual) {
    parts.push("👤 manual");
  }

  if (task.blockedReason) {
    parts.push(`🔴 blocked: ${task.blockedReason}`);
  }

  if (task.completedDate) {
    parts.push(`✅ ${task.completedDate}`);
  }

  return parts.join(" ");
}
