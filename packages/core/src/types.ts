import type { ToolDefinition, ToolCall } from "@cherryagent/tools";

export interface ModelConfig {
  id: string;
  provider: string;
  tier: 0 | 1 | 2 | 3;
}

export interface AgentLoopConfig {
  maxIterations: number;
  maxTokenBudget: number;
  maxWallTime: number;
  model: ModelConfig;
  tools: ToolDefinition[];
  approvalRequired: string[];
  onPause: "queue" | "notify" | "discard";
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ChatParams {
  messages: Message[];
  tools?: ToolDefinition[];
  systemInstruction?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  jsonSchema?: Record<string, unknown>;
}

export interface LLMProvider {
  id: string;
  tier: 0 | 1 | 2 | 3;
  inputCostPer1M: number;
  outputCostPer1M: number;
  maxContextTokens: number;
  supportsToolCalling: boolean;

  chat(params: ChatParams): Promise<LLMResponse>;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[] | null;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: "stop" | "tool_calls" | "length" | "error";
}
