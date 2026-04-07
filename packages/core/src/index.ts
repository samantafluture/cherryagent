export { AgentLoop } from "./agent-loop.js";
export { GeminiProvider } from "./providers/gemini.js";
export type {
  ChatWithImageParams,
  ChatWithVideoParams,
  ChatWithYouTubeUrlParams,
  ChatWithGroundingParams,
  GroundedResponse,
} from "./providers/gemini.js";
export {
  FOOD_PARSE_SYSTEM_PROMPT,
  CLASSIFY_IMAGE_PROMPT,
  EXTRACT_LABEL_PROMPT,
  ESTIMATE_FOOD_PROMPT,
  CORRECT_FOOD_PROMPT,
} from "./prompts/food-logging.js";
export {
  YOUTUBE_COMPREHENSION_PROMPT,
  YOUTUBE_COMPREHENSION_TRANSCRIPT_PROMPT,
  YOUTUBE_SOURCE_EXPANSION_PROMPT,
  YOUTUBE_PERSONALIZATION_PROMPT,
} from "./prompts/youtube-notes.js";
export type {
  AgentLoopConfig,
  ChatParams,
  LLMProvider,
  LLMResponse,
  Message,
  ModelConfig,
} from "./types.js";
