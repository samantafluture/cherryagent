export type {
  Tool,
  ToolDefinition,
  ToolCall,
  ToolResult,
  ExecutionContext,
  Permission,
} from "./types.js";
export { ToolRegistry } from "./registry.js";

// Nutrition
export type { NutritionData, FoodFavorite } from "./nutrition/types.js";
export { barcodeLookupTool } from "./nutrition/barcode-lookup.js";
export {
  addFoodFavorite,
  listFoodFavorites,
  getFoodFavoriteByIndex,
  removeFoodFavoriteByIndex,
} from "./nutrition/food-favorites.js";
export {
  trackSaturatedFat,
  getDailySaturatedFat,
  getWeeklySaturatedFat,
} from "./nutrition/sat-fat-tracker.js";

// Fitbit
export { FitbitAuth } from "./fitbit/auth.js";
export { createFitbitLogFoodTool } from "./fitbit/food-log.js";
export { FitbitFoodLogReader } from "./fitbit/food-log-reader.js";
export type { DailySummary, WeeklySummary } from "./fitbit/food-log-reader.js";
export { formatOnDemandReport, formatWeeklyReport } from "./fitbit/sat-fat-report.js";
export { startWeeklyReport } from "./fitbit/weekly-scheduler.js";

// Cost
export type { CostEntry } from "./cost/cost-tracker.js";
export { logCost, getCostsForDate, getCostsForRange, getDailyCost, getMonthlyCost } from "./cost/cost-tracker.js";
export { formatCostReport, checkSpendWarning } from "./cost/cost-report.js";

// Inspiration
export { uploadToInspirationBoard } from "./inspiration/upload.js";
export type { InspirationUploadResult } from "./inspiration/upload.js";

// Tasks
export type {
  Task,
  Subtask,
  TaskFile,
  SectionContent,
  Priority,
  Size,
  TaskStatus,
  ProjectEntry,
  ProjectOverview,
  GitSyncResult,
  SyncSchedulerOpts,
} from "./tasks/index.js";
export {
  parseTaskFile,
  serializeTaskFile,
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
  listProjects,
  getOverview,
  commitAndPush,
  pullChanges,
  pullAllProjects,
  startSyncScheduler,
} from "./tasks/index.js";

// Media
export type {
  YouTubeMode,
  VideoMetadata,
  DownloadResult,
  AudioExtractionResult,
  PipelineResult,
  ProgressStep,
  FavoriteItem,
} from "./media/types.js";
export type { MediaConfig } from "./media/config.js";
export { getMediaConfig } from "./media/config.js";
export { isYouTubeUrl, validateYouTubeUrl } from "./media/validate-url.js";
export { downloadVideo } from "./media/download.js";
export { extractAudio } from "./media/extract-audio.js";
export { startMediaCleanup, runCleanup } from "./media/cleanup.js";
export { runYouTubePipeline } from "./media/youtube-pipeline.js";
export type { PipelineDeps } from "./media/youtube-pipeline.js";
export {
  addFavorite,
  listFavorites,
  getFavoriteByIndex,
  removeFavoriteByIndex,
} from "./media/yt-favorites.js";
