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
export type { NutritionData } from "./nutrition/types.js";
export { barcodeLookupTool } from "./nutrition/barcode-lookup.js";

// Fitbit
export { FitbitAuth } from "./fitbit/auth.js";
export { createFitbitLogFoodTool } from "./fitbit/food-log.js";

// Media
export type {
  YouTubeMode,
  VideoMetadata,
  DownloadResult,
  AudioExtractionResult,
  PipelineResult,
  ProgressStep,
} from "./media/types.js";
export type { MediaConfig } from "./media/config.js";
export { getMediaConfig } from "./media/config.js";
export { isYouTubeUrl, validateYouTubeUrl } from "./media/validate-url.js";
export { downloadVideo } from "./media/download.js";
export { extractAudio } from "./media/extract-audio.js";
export { startMediaCleanup, runCleanup } from "./media/cleanup.js";
export { runYouTubePipeline } from "./media/youtube-pipeline.js";
export type { PipelineDeps } from "./media/youtube-pipeline.js";
