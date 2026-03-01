import { GoogleGenAI } from "@google/genai";
import type { ToolDefinition } from "@cherryagent/tools";
import type { ChatParams, LLMProvider, LLMResponse, Message } from "../types.js";

export interface ChatWithImageParams {
  prompt: string;
  imageBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  systemInstruction?: string;
  tools?: ToolDefinition[];
  jsonMode?: boolean;
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { inlineData: { data: string; mimeType: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export class GeminiProvider implements LLMProvider {
  id: string;
  tier: 0 | 1 | 2 | 3;
  inputCostPer1M: number;
  outputCostPer1M: number;
  maxContextTokens: number;
  supportsToolCalling = true;

  private client: GoogleGenAI;
  private model: string;

  constructor(config: {
    apiKey: string;
    model?: string;
    tier?: 0 | 1 | 2 | 3;
  }) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
    this.model = config.model ?? "gemini-2.5-flash";
    this.tier = config.tier ?? 2;
    this.id = this.model;

    // Costs with thinking OFF (thinkingBudget: 0)
    if (this.model === "gemini-2.5-flash") {
      this.inputCostPer1M = 0.15;
      this.outputCostPer1M = 0.60;
      this.maxContextTokens = 1_048_576;
    } else {
      // Default / flash-lite
      this.inputCostPer1M = 0.10;
      this.outputCostPer1M = 0.40;
      this.maxContextTokens = 1_048_576;
    }
  }

  async chat(params: ChatParams): Promise<LLMResponse> {
    const { systemInstruction, messages, tools, temperature, maxTokens, jsonMode, jsonSchema } =
      params;

    const contents = this.convertMessages(messages);
    const geminiTools = this.convertTools(tools);

    const config: Record<string, unknown> = {
      temperature: temperature ?? 0.3,
      maxOutputTokens: maxTokens ?? 1024,
      thinkingConfig: { thinkingBudget: 0 },
    };

    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }
    if (geminiTools) {
      config.tools = geminiTools;
    }
    if (jsonMode) {
      config.responseMimeType = "application/json";
    }
    if (jsonSchema) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = jsonSchema;
    }

    const response = await this.client.models.generateContent({
      model: this.model,
      contents,
      config,
    });

    return this.normalizeResponse(response);
  }

  async chatWithImage(params: ChatWithImageParams): Promise<LLMResponse> {
    const contents: GeminiContent[] = [
      {
        role: "user",
        parts: [
          { inlineData: { data: params.imageBase64, mimeType: params.mimeType } },
          { text: params.prompt },
        ],
      },
    ];

    const geminiTools = this.convertTools(params.tools);

    const config: Record<string, unknown> = {
      temperature: params.temperature ?? 0.2,
      maxOutputTokens: params.maxTokens ?? 512,
      thinkingConfig: { thinkingBudget: 0 },
    };

    if (params.systemInstruction) {
      config.systemInstruction = params.systemInstruction;
    }
    if (geminiTools) {
      config.tools = geminiTools;
    }
    if (params.jsonMode) {
      config.responseMimeType = "application/json";
    }
    if (params.jsonSchema) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = params.jsonSchema;
    }

    const response = await this.client.models.generateContent({
      model: this.model,
      contents,
      config,
    });

    return this.normalizeResponse(response);
  }

  private convertMessages(messages: Message[]): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      // Skip system messages — handled via systemInstruction config
      if (msg.role === "system") continue;

      if (msg.role === "tool" && msg.toolCallId) {
        // Tool result → Gemini functionResponse
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(msg.content ?? "{}");
        } catch {
          parsed = { result: msg.content };
        }
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: msg.toolCallId,
                response: parsed,
              },
            },
          ],
        });
      } else if (msg.role === "assistant" && msg.toolCalls?.length) {
        // Assistant with tool calls → Gemini model with functionCall parts
        const parts: GeminiPart[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.arguments,
            },
          });
        }
        contents.push({ role: "model", parts });
      } else {
        // Regular text message
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content ?? "" }],
        });
      }
    }

    return contents;
  }

  private convertTools(
    tools?: ToolDefinition[],
  ): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
    if (!tools?.length) return undefined;
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.parameters,
        })),
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private normalizeResponse(response: any): LLMResponse {
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const parts: Record<string, unknown>[] = candidate?.content?.parts ?? [];

    // Extract text (excluding thought parts)
    const textParts: string[] = [];
    for (const part of parts) {
      if (typeof part.text === "string" && !part.thought) {
        textParts.push(part.text);
      }
    }

    // Extract function calls (use response.functionCalls convenience accessor)
    const functionCalls: { name: string; args: Record<string, unknown> }[] =
      response.functionCalls ?? [];

    const toolCalls =
      functionCalls.length > 0
        ? functionCalls.map((fc) => ({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: fc.name,
            arguments: fc.args ?? {},
          }))
        : null;

    // Map Gemini finish reasons to our unified format
    let mappedFinishReason: LLMResponse["finishReason"] = "stop";
    if (toolCalls) {
      mappedFinishReason = "tool_calls";
    } else if (finishReason === "MAX_TOKENS") {
      mappedFinishReason = "length";
    } else if (finishReason === "SAFETY" || finishReason === "RECITATION") {
      mappedFinishReason = "error";
    }

    return {
      content: textParts.join("") || null,
      toolCalls,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
      finishReason: mappedFinishReason,
    };
  }
}
