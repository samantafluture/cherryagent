export type { NotionTask } from "./client.js";
export {
  queryTasksByProject,
  queryRecentlyCompleted,
  queryAllActiveTasks,
  queryAllRecentlyCompleted,
} from "./client.js";

export type { NotionProjectMapping } from "./config.js";
export { getProjectMapping, getAllProjectMappings } from "./config.js";

export { buildTaskFile, renderTasksMarkdown } from "./renderer.js";

export type { SyncResult, NotionSyncSchedulerOpts } from "./sync.js";
export { syncProject, syncAllProjects, startNotionSyncScheduler } from "./sync.js";

export {
  updateNotionTaskStatus,
  updateNotionTaskResult,
  clearDelegateCheckbox,
  addNotionComment,
  markTaskDone,
  markTaskFailed,
  createSubtasksInNotion,
} from "./writer.js";

export type { TriageResult } from "./triage.js";
export { triageTask } from "./triage.js";

export type { DelegationResult, DelegationPollerOpts } from "./delegate.js";
export {
  pollDelegatedTasks,
  executeDelegatedTask,
  processDelegatedTasks,
  startDelegationPoller,
} from "./delegate.js";
