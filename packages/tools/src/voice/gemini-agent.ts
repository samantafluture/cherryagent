import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgentRunResult } from "./types.js";

/** Minimal LLM provider interface — matches GeminiProvider.chat() signature */
export interface AgentLLMProvider {
  chat(params: {
    messages: { role: "user" | "system" | "assistant" | "tool"; content: string | null }[];
    systemInstruction?: string;
    jsonSchema?: Record<string, unknown>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{
    content: string | null;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}

interface FileChange {
  path: string;
  content: string;
}

interface AgentResponse {
  explanation: string;
  files: FileChange[];
}

const AGENT_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    explanation: {
      type: "string" as const,
      description: "Brief explanation of what was changed and why",
    },
    files: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          path: {
            type: "string" as const,
            description: "Relative file path from repo root",
          },
          content: {
            type: "string" as const,
            description: "Complete new file content",
          },
        },
        required: ["path", "content"],
      },
      description: "Files to create or overwrite with their full content",
    },
  },
  required: ["explanation", "files"],
};

const MAX_FILE_SIZE = 50_000; // Skip files larger than 50KB
const MAX_FILES_TO_READ = 30;

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache",
  "coverage", ".turbo", ".vercel", "__pycache__",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".scss",
  ".html", ".md", ".yml", ".yaml", ".toml", ".env.example",
  ".sh", ".sql", ".graphql", ".svelte", ".vue",
]);

/**
 * Run Gemini Flash as a coding agent on a repo.
 * Reads relevant files, sends context + task to Gemini, applies file changes.
 */
export async function runGeminiAgent(opts: {
  gemini: AgentLLMProvider;
  repoPath: string;
  prompt: string;
  taskType: string;
}): Promise<AgentRunResult> {
  const { gemini, repoPath, prompt, taskType } = opts;

  try {
    // 1. Discover relevant files in the repo
    const filePaths = await discoverFiles(repoPath);

    // 2. Read file contents to build context
    const fileContents = await readRepoFiles(repoPath, filePaths);

    // 3. Build the prompt with repo context
    const systemInstruction = buildSystemPrompt(taskType);
    const userMessage = buildUserMessage(prompt, fileContents);

    // 4. Call Gemini Flash with JSON mode
    const response = await gemini.chat({
      messages: [{ role: "user", content: userMessage }],
      systemInstruction,
      jsonSchema: AGENT_RESPONSE_SCHEMA,
      temperature: 0.2,
      maxTokens: 8192,
    });

    if (!response.content) {
      return {
        success: false,
        output: "Gemini returned empty response",
        filesChanged: 0,
        error: "Empty response from Gemini",
      };
    }

    // 5. Parse the JSON response
    let agentResponse: AgentResponse;
    try {
      agentResponse = JSON.parse(response.content);
    } catch {
      return {
        success: false,
        output: response.content,
        filesChanged: 0,
        error: "Failed to parse Gemini response as JSON",
      };
    }

    // 6. Write file changes to disk
    let filesWritten = 0;
    for (const file of agentResponse.files) {
      // Prevent path traversal
      const resolved = join(repoPath, file.path);
      if (!resolved.startsWith(repoPath)) {
        console.warn(`[voice] Skipping path traversal attempt: ${file.path}`);
        continue;
      }
      await writeFile(resolved, file.content, "utf-8");
      filesWritten++;
    }

    return {
      success: true,
      output: agentResponse.explanation,
      filesChanged: filesWritten,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      filesChanged: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function discoverFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string) {
    if (files.length >= MAX_FILES_TO_READ) return;

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES_TO_READ) return;

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = entry.name.includes(".")
          ? "." + entry.name.split(".").pop()!
          : "";
        if (CODE_EXTENSIONS.has(ext) || entry.name === "package.json") {
          files.push(relative(repoPath, join(dir, entry.name)));
        }
      }
    }
  }

  await walk(repoPath);
  return files;
}

async function readRepoFiles(
  repoPath: string,
  filePaths: string[],
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();

  for (const filePath of filePaths) {
    try {
      const fullPath = join(repoPath, filePath);
      const stats = await stat(fullPath);
      if (stats.size > MAX_FILE_SIZE) continue;

      const content = await readFile(fullPath, "utf-8");
      contents.set(filePath, content);
    } catch {
      // Skip unreadable files
    }
  }

  return contents;
}

function buildSystemPrompt(taskType: string): string {
  return `You are a coding agent. Your task type is: ${taskType}.

You will receive the contents of a code repository and a task description.
Analyze the code and produce the necessary file changes to complete the task.

Rules:
- Only modify files that need changes
- Return the COMPLETE content of each modified file (not diffs)
- Keep changes minimal and focused on the task
- Follow existing code style and conventions
- Do not add unnecessary dependencies
- Ensure the code compiles and is correct`;
}

function buildUserMessage(
  prompt: string,
  fileContents: Map<string, string>,
): string {
  const parts: string[] = [
    "## Task",
    prompt,
    "",
    "## Repository Files",
  ];

  for (const [path, content] of fileContents) {
    parts.push(`### ${path}`, "```", content, "```", "");
  }

  return parts.join("\n");
}
