import type { AgentLoopConfig, LLMProvider, LLMResponse, Message } from "./types.js";

export class AgentLoop {
  private config: AgentLoopConfig;
  private messages: Message[] = [];
  private iterations = 0;

  constructor(config: AgentLoopConfig) {
    this.config = config;
  }

  async run(provider: LLMProvider, systemPrompt: string, taskPrompt: string): Promise<LLMResponse> {
    this.messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: taskPrompt },
    ];

    while (this.iterations < this.config.maxIterations) {
      this.iterations++;

      const response = await provider.chat({
        messages: this.messages,
        tools: this.config.tools,
      });

      if (response.finishReason === "stop" || response.finishReason === "error") {
        return response;
      }

      if (response.finishReason === "tool_calls" && response.toolCalls) {
        this.messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
        });

        // Tool execution will be handled by the worker that owns this loop
        // Return to caller so it can execute tools and feed results back
        return response;
      }

      // Length or unexpected finish — return what we have
      return response;
    }

    return {
      content: `Agent loop reached max iterations (${this.config.maxIterations})`,
      toolCalls: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: "error",
    };
  }

  addToolResult(toolCallId: string, result: string): void {
    this.messages.push({
      role: "tool",
      content: result,
      toolCallId,
    });
  }

  getIterations(): number {
    return this.iterations;
  }
}
