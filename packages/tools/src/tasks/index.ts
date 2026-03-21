export type {
  Task,
  Subtask,
  TaskFile,
  SectionContent,
  Priority,
  Size,
  TaskStatus,
} from "./types.js";

export { parseTaskFile } from "./parser.js";
export { serializeTaskFile } from "./serializer.js";

export {
  loadTaskFile,
  saveTaskFile,
  addTask,
  updateTaskStatus,
  deleteTask,
  reorderTask,
  changeTaskPriority,
  addTaskNote,
  editTaskTitle,
  findTask,
  getAllTasks,
  getActiveTasks,
} from "./crud.js";

export type { ProjectEntry, ProjectOverview } from "./projects.js";
export { listProjects, getOverview } from "./projects.js";

export type { GitSyncResult } from "./git-sync.js";
export { commitAndPush, commitAndPushFiles, pullChanges, pullAllProjects } from "./git-sync.js";

export type { SyncSchedulerOpts } from "./sync-scheduler.js";
export { startSyncScheduler } from "./sync-scheduler.js";
