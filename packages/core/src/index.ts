export { AgentLoop } from "./agent-loop.js";
export { GeminiProvider } from "./providers/gemini.js";
export type { ChatWithImageParams } from "./providers/gemini.js";
export {
  FOOD_PARSE_SYSTEM_PROMPT,
  CLASSIFY_IMAGE_PROMPT,
  EXTRACT_LABEL_PROMPT,
  ESTIMATE_FOOD_PROMPT,
  CORRECT_FOOD_PROMPT,
} from "./prompts/food-logging.js";
export type {
  AgentLoopConfig,
  ChatParams,
  LLMProvider,
  LLMResponse,
  Message,
  ModelConfig,
} from "./types.js";
