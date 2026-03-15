import { parseTaskFile } from "./parser.js";
import { addTask, updateTaskStatus, deleteTask, reorderTask, addTaskNote, findTask, getAllTasks, getActiveTasks } from "./crud.js";
import { listProjects, getOverview } from "./projects.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); failed++; }
}

// Create a minimal task file for testing
const MINIMAL = `# Project: TestProject

> Last synced to repo: —
> Last agent update: 2026-03-15

## Active Sprint

### P0 — Must do now

### P1 — Should do this week
- [ ] Existing task one \`[M]\` #backend

### P2 — Nice to have
- [ ] Low priority thing \`[S]\` #cleanup

## Blocked

## Completed (recent)
- [x] Old task \`[S]\` #setup ✅ 2026-03-14

## Notes
- This is a test project
`;

console.log("\n--- CRUD: addTask ---");
const file = parseTaskFile(MINIMAL);
const newTask = addTask(file, { title: "New feature", priority: "P1", size: "L", tags: ["frontend"] });
assert(newTask.id.length === 8, "new task has ID");
assertEq(newTask.title, "New feature", "new task title");
assertEq(file.sections.activeP1.tasks.length, 2, "P1 now has 2 tasks");

console.log("\n--- CRUD: updateTaskStatus ---");
const doneTask = updateTaskStatus(file, newTask.id, "done");
assert(doneTask !== null, "task found for status update");
assertEq(doneTask!.checkbox, true, "done task is checked");
assert(doneTask!.completedDate !== undefined, "done task has completion date");
assertEq(file.sections.activeP1.tasks.length, 1, "P1 back to 1 task");
assertEq(file.sections.completed.tasks.length, 2, "completed now has 2");
assertEq(file.sections.completed.tasks[0].title, "New feature", "new task at top of completed");

console.log("\n--- CRUD: deleteTask ---");
const p2Task = file.sections.activeP2.tasks[0];
const deleted = deleteTask(file, p2Task.id);
assert(deleted, "task deleted");
assertEq(file.sections.activeP2.tasks.length, 0, "P2 now empty");

console.log("\n--- CRUD: reorderTask ---");
addTask(file, { title: "Task A", priority: "P1" });
addTask(file, { title: "Task B", priority: "P1" });
const taskA = file.sections.activeP1.tasks[1];
const taskB = file.sections.activeP1.tasks[2];
const reordered = reorderTask(file, taskB.id, "up");
assert(reordered, "reorder succeeded");
assertEq(file.sections.activeP1.tasks[1].title, "Task B", "Task B moved up");
assertEq(file.sections.activeP1.tasks[2].title, "Task A", "Task A moved down");

console.log("\n--- CRUD: addTaskNote ---");
const noted = addTaskNote(file, taskB.id, "This is important");
assert(noted, "note added");
assertEq(findTask(file, taskB.id)!.notes.length, 1, "task has 1 note");

console.log("\n--- CRUD: getAllTasks / getActiveTasks ---");
const all = getAllTasks(file);
const active = getActiveTasks(file);
assert(all.length > active.length, "all > active (includes completed)");
assert(active.every(t => t.status === "active"), "active tasks all have active status");

console.log("\n--- Projects: listProjects ---");
const projects = listProjects();
assert(projects.length >= 2, `found ${projects.length} projects with tasks.md`);
assert(projects.some(p => p.slug === "saminprogress"), "found saminprogress");
assert(projects.some(p => p.slug === "voila-prep"), "found voila-prep");

console.log("\n--- Projects: getOverview ---");
const overview = getOverview(projects);
assert(overview.length >= 2, `overview has ${overview.length} projects`);
for (const p of overview) {
  assert(p.totalTasks > 0, `${p.slug}: has tasks (${p.totalTasks})`);
  console.log(`    ${p.slug}: ${p.activeTasks} active / ${p.totalTasks} total — top: ${p.topTask ?? "none"}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
