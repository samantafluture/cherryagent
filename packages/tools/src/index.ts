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
