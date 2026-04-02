import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);

const MODEL = "claude-sonnet-4-20250514";
const MAX_TURNS = 25;
const MAX_TOKENS = 16384;
const BASH_TIMEOUT = 60_000; // 60s per bash command

interface AgentResult {
  output: string;
  success: boolean;
}

const SYSTEM_PROMPT = `You are an AI coding agent working on a software project. You have access to tools to read files, write files, and run bash commands.

Rules:
- Be focused and efficient. Go straight to the relevant files.
- Read CLAUDE.md first if it exists for project conventions.
- Do NOT push or create branches — the orchestrator handles git.
- Commit your changes with a descriptive message using git add + git commit.
- When done, write a brief summary of what you changed.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read a file from the project. Returns the file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates parent directories if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "bash",
    description: "Run a bash command in the project directory. Use for git, ls, grep, etc.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
      },
      required: ["command"],
    },
  },
];

async function executeTool(
  toolName: string,
  input: Record<string, string>,
  cwd: string,
): Promise<string> {
  switch (toolName) {
    case "read_file": {
      const fullPath = input["path"]!.startsWith("/") ? input["path"]! : `${cwd}/${input["path"]}`;
      return readFile(fullPath, "utf-8").catch((e: Error) => `Error: ${e.message}`);
    }
    case "write_file": {
      const fullPath = input["path"]!.startsWith("/") ? input["path"]! : `${cwd}/${input["path"]}`;
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, input["content"]!, "utf-8");
      return `Written to ${input["path"]}`;
    }
    case "bash": {
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-c", input["command"]!], {
          cwd,
          timeout: BASH_TIMEOUT,
          maxBuffer: 512 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        const output = (stdout + stderr).trim();
        return output || "(no output)";
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string };
        return `Error (exit code): ${(e.stderr ?? "") + (e.stdout ?? "") || e.message}`.slice(0, 2000);
      }
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

/**
 * Run a mini Claude Code agent loop: send prompt, execute tool calls,
 * collect results, repeat until done or max turns reached.
 */
export async function runAgent(prompt: string, cwd: string): Promise<AgentResult> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is required");

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const outputParts: string[] = [];
  let turns = 0;

  while (turns < MAX_TURNS) {
    turns++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Collect any text output
    const textBlocks = response.content.filter((b) => b.type === "text");
    for (const block of textBlocks) {
      outputParts.push(block.text);
    }

    // If no tool use, we're done
    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      break;
    }

    // Execute tool calls
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    if (toolUseBlocks.length === 0) break;

    // Add assistant message with all content blocks
    messages.push({ role: "assistant", content: response.content });

    // Execute each tool and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      console.log(`[agent] Turn ${turns}: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);
      const result = await executeTool(
        toolUse.name,
        toolUse.input as Record<string, string>,
        cwd,
      );
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.slice(0, 50_000), // cap tool results
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  const output = outputParts.join("\n").trim();
  return {
    output: output || `Agent completed in ${turns} turns (no text output)`,
    success: true,
  };
}
