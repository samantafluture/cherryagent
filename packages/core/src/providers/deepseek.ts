import type { ChatParams, LLMProvider, LLMResponse } from "../types.js";

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class DeepSeekProvider implements LLMProvider {
  id = "deepseek-chat";
  tier: 0 | 1 | 2 | 3 = 1;
  inputCostPer1M = 0.15;
  outputCostPer1M = 0.75;
  maxContextTokens = 65_536;
  supportsToolCalling = false;

  private apiKey: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.deepseek.com/v1";
  }

  async chat(params: ChatParams): Promise<LLMResponse> {
    const messages: DeepSeekMessage[] = [];

    if (params.systemInstruction) {
      messages.push({ role: "system", content: params.systemInstruction });
    }

    for (const msg of params.messages) {
      if (msg.role === "system") continue; // handled above
      if (msg.role === "tool") continue; // DeepSeek doesn't do tool calls
      messages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content ?? "",
      });
    }

    const body: Record<string, unknown> = {
      model: "deepseek-chat",
      messages,
      temperature: params.temperature ?? 0.3,
      max_tokens: params.maxTokens ?? 4096,
    };

    if (params.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: {
        message: { content: string };
        finish_reason: string;
      }[];
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
      };
    };

    const choice = data.choices[0];
    let finishReason: LLMResponse["finishReason"] = "stop";
    if (choice?.finish_reason === "length") finishReason = "length";

    return {
      content: choice?.message.content ?? null,
      toolCalls: null,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      finishReason,
    };
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    return (inputTokens / 1_000_000) * this.inputCostPer1M +
      (outputTokens / 1_000_000) * this.outputCostPer1M;
  }
}
