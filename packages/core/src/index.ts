export { AgentLoop } from "./agent-loop.js";
export { GeminiProvider } from "./providers/gemini.js";
export type { ChatWithImageParams, ChatWithVideoParams } from "./providers/gemini.js";
export { GroqWhisperClient } from "./providers/groq-whisper.js";
export type { TranscriptionResult, TranscriptionSegment } from "./providers/groq-whisper.js";
export { DeepSeekProvider } from "./providers/deepseek.js";
export {
  FOOD_PARSE_SYSTEM_PROMPT,
  CLASSIFY_IMAGE_PROMPT,
  EXTRACT_LABEL_PROMPT,
  ESTIMATE_FOOD_PROMPT,
  CORRECT_FOOD_PROMPT,
} from "./prompts/food-logging.js";
export {
  YOUTUBE_NOTES_SYSTEM_PROMPT,
  YOUTUBE_NOTES_RICH_SYSTEM_PROMPT,
} from "./prompts/youtube-notes.js";
export type {
  AgentLoopConfig,
  ChatParams,
  LLMProvider,
  LLMResponse,
  Message,
  ModelConfig,
} from "./types.js";
