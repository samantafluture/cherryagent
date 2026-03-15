import { parseTaskFile } from "./parser.js";
import { serializeTaskFile } from "./serializer.js";
import { readFileSync } from "fs";
import { resolve } from "path";

const PASS = "✓";
const FAIL = "✗";
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed++;
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---------- Test: Parse saminprogress tasks.md ----------

console.log("\n--- Parsing saminprogress tasks.md ---");

const sipPath = resolve("/home/samantafluture/Development/saminprogress/.claude/tasks.md");
const sipContent = readFileSync(sipPath, "utf-8");
const sipFile = parseTaskFile(sipContent);

assertEq(sipFile.projectName, "saminprogress", "project name");
assertEq(sipFile.lastSyncedToRepo, "2026-03-14", "last synced");
assertEq(sipFile.lastAgentUpdate, "2026-03-14", "last agent update");

// P0 — freeform line
assertEq(sipFile.sections.activeP0.tasks.length, 0, "P0 has no tasks");
assertEq(sipFile.sections.activeP0.freeformLines.length, 1, "P0 has freeform line");
assertEq(sipFile.sections.activeP0.freeformLines[0], "All P0 tasks completed.", "P0 freeform text");

// P1
assert(sipFile.sections.activeP1.tasks.length === 4, `P1 has 4 tasks (got ${sipFile.sections.activeP1.tasks.length})`);
const a11yTask = sipFile.sections.activeP1.tasks[0];
assert(a11yTask.title.includes("Accessibility fixes"), "P1 first task title");
assertEq(a11yTask.checkbox, true, "P1 first task checked");
assertEq(a11yTask.size, "M", "P1 first task size");
assert(a11yTask.tags.includes("a11y"), "P1 first task has #a11y tag");
assertEq(a11yTask.completedDate, "2026-03-14", "P1 first task completed date");
assertEq(a11yTask.subtasks.length, 4, "P1 first task has 4 subtasks");
assertEq(a11yTask.notes.length, 2, "P1 first task has 2 notes");

// Domain task (blocked)
const domainTask = sipFile.sections.activeP1.tasks[3];
assert(domainTask.title.includes("domain setup"), "domain task title");
assertEq(domainTask.checkbox, false, "domain task unchecked");
assert(domainTask.blockedReason !== undefined, "domain task has blocked reason");
assertEq(domainTask.subtasks.length, 6, "domain task has 6 subtasks");
assertEq(domainTask.notes.length, 2, "domain task has 2 notes");

// P2
assertEq(sipFile.sections.activeP2.tasks.length, 1, "P2 has 1 task");

// Completed
assert(sipFile.sections.completed.tasks.length > 10, `Completed has many tasks (got ${sipFile.sections.completed.tasks.length})`);

// Notes section
assert(sipFile.sections.notes.length > 0, "has notes section content");

// ---------- Test: Parse voila-prep tasks.md ----------

console.log("\n--- Parsing voila-prep tasks.md ---");

const vpPath = resolve("/home/samantafluture/Development/voila-prep/.claude/tasks.md");
const vpContent = readFileSync(vpPath, "utf-8");
const vpFile = parseTaskFile(vpContent);

assertEq(vpFile.projectName, "Voilà Prep", "project name");
assertEq(vpFile.lastSyncedToRepo, "—", "last synced is —");

// P0
assertEq(vpFile.sections.activeP0.tasks.length, 3, "P0 has 3 tasks");
const geminiTask = vpFile.sections.activeP0.tasks[0];
assert(geminiTask.title.includes("Gemini API key"), "P0 first task title");
assertEq(geminiTask.manual, true, "P0 first task is manual");
assertEq(geminiTask.size, "S", "P0 first task size");

// P1
assert(vpFile.sections.activeP1.tasks.length >= 5, `P1 has tasks (got ${vpFile.sections.activeP1.tasks.length})`);

// Completed
assert(vpFile.sections.completed.tasks.length >= 8, `Completed has tasks (got ${vpFile.sections.completed.tasks.length})`);

// ---------- Test: Round-trip serialization ----------

console.log("\n--- Round-trip serialization ---");

// Parse → serialize → parse again, compare structure
const sipReserialized = serializeTaskFile(sipFile);
const sipReparsed = parseTaskFile(sipReserialized);

assertEq(sipReparsed.projectName, sipFile.projectName, "round-trip: project name preserved");
assertEq(sipReparsed.sections.activeP1.tasks.length, sipFile.sections.activeP1.tasks.length, "round-trip: P1 task count preserved");
assertEq(sipReparsed.sections.completed.tasks.length, sipFile.sections.completed.tasks.length, "round-trip: completed task count preserved");
assertEq(sipReparsed.sections.notes.length, sipFile.sections.notes.length, "round-trip: notes count preserved");

// Verify task IDs are stable
assertEq(sipReparsed.sections.activeP1.tasks[0].id, sipFile.sections.activeP1.tasks[0].id, "round-trip: task IDs stable");

// Verify subtask counts survive
assertEq(
  sipReparsed.sections.activeP1.tasks[0].subtasks.length,
  sipFile.sections.activeP1.tasks[0].subtasks.length,
  "round-trip: subtask count preserved"
);

// ---------- Test: Task ID generation ----------

console.log("\n--- Task ID generation ---");

const task1 = sipFile.sections.activeP1.tasks[0];
const task2 = sipFile.sections.activeP1.tasks[1];
assert(task1.id !== task2.id, "different tasks get different IDs");
assert(task1.id.length === 8, "ID is 8 chars");

// ---------- Summary ----------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
