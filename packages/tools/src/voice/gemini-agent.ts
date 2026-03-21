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

interface PlanResponse {
  approach: string;
  relevantFiles: string[];
  filesToCreate: string[];
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

const PLAN_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    approach: {
      type: "string" as const,
      description: "Step-by-step plan for completing the task (2-5 sentences)",
    },
    relevantFiles: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "File paths that need to be read to complete the task",
    },
    filesToCreate: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "New file paths to create (if any)",
    },
  },
  required: ["approach", "relevantFiles", "filesToCreate"],
};

const MAX_FILE_SIZE = 50_000; // Skip files larger than 50KB
const MAX_FILES_TO_READ = 50;
const MAX_OUTPUT_TOKENS = 32_768;

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache",
  "coverage", ".turbo", ".vercel", "__pycache__",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".scss",
  ".html", ".md", ".yml", ".yaml", ".toml", ".env.example",
  ".sh", ".sql", ".graphql", ".svelte", ".vue",
]);

/** Files that provide essential repo context — always included first */
const CONVENTION_FILES = [
  "CLAUDE.md",
  "package.json",
  "tsconfig.json",
  ".env.example",
];

/**
 * Run Gemini Flash as a coding agent on a repo.
 * Two-phase approach: plan (identify relevant files) → execute (generate changes).
 */
export async function runGeminiAgent(opts: {
  gemini: AgentLLMProvider;
  repoPath: string;
  prompt: string;
  taskType: string;
}): Promise<AgentRunResult> {
  const { gemini, repoPath, prompt, taskType } = opts;

  try {
    // 1. Discover all files in the repo (paths only, for the planning step)
    const allFilePaths = await discoverFiles(repoPath);

    // 2. Read convention files for context
    const conventionContents = await readConventionFiles(repoPath);

    // 3. Phase 1 — Planning: ask Gemini which files are relevant
    const plan = await runPlanningPhase(gemini, {
      prompt,
      taskType,
      filePaths: allFilePaths,
      conventionContents,
    });

    // 4. Read only the relevant files identified by the plan
    const relevantPaths = plan.relevantFiles.filter((f) => allFilePaths.includes(f));
    const fileContents = await readRepoFiles(repoPath, relevantPaths);

    // 5. Phase 2 — Execution: generate the actual code changes
    const systemInstruction = buildSystemPrompt(taskType, conventionContents);
    const userMessage = buildUserMessage(prompt, plan.approach, fileContents);

    const response = await gemini.chat({
      messages: [{ role: "user", content: userMessage }],
      systemInstruction,
      jsonSchema: AGENT_RESPONSE_SCHEMA,
      temperature: 0.2,
      maxTokens: MAX_OUTPUT_TOKENS,
    });

    if (!response.content) {
      return {
        success: false,
        output: "Gemini returned empty response",
        filesChanged: 0,
        changedFiles: [],
        error: "Empty response from Gemini",
      };
    }

    // 6. Parse the JSON response
    let agentResponse: AgentResponse;
    try {
      agentResponse = JSON.parse(response.content);
    } catch {
      return {
        success: false,
        output: response.content,
        filesChanged: 0,
        changedFiles: [],
        error: "Failed to parse Gemini response as JSON",
      };
    }

    // 7. Validate: reject empty responses
    if (!agentResponse.files || agentResponse.files.length === 0) {
      return {
        success: false,
        output: agentResponse.explanation || "No file changes produced",
        filesChanged: 0,
        changedFiles: [],
        error: "Agent produced no file changes",
      };
    }

    // 8. Write file changes to disk
    const changedFiles: string[] = [];
    for (const file of agentResponse.files) {
      // Prevent path traversal
      const resolved = join(repoPath, file.path);
      if (!resolved.startsWith(repoPath)) {
        console.warn(`[voice] Skipping path traversal attempt: ${file.path}`);
        continue;
      }
      await writeFile(resolved, file.content, "utf-8");
      changedFiles.push(file.path);
    }

    return {
      success: changedFiles.length > 0,
      output: agentResponse.explanation,
      filesChanged: changedFiles.length,
      changedFiles,
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
      changedFiles: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Phase 1: Ask Gemini to plan which files are relevant before reading them all.
 * This is cheap (small input: file paths only, no content) and focuses the execution phase.
 */
async function runPlanningPhase(
  gemini: AgentLLMProvider,
  opts: {
    prompt: string;
    taskType: string;
    filePaths: string[];
    conventionContents: Map<string, string>;
  },
): Promise<PlanResponse> {
  const { prompt, taskType, filePaths, conventionContents } = opts;

  const conventionContext = buildConventionContext(conventionContents);

  const systemInstruction = `You are a coding assistant planning phase. Your task type is: ${taskType}.

You will receive a task description and a list of file paths in a repository.
Your job is to identify which files need to be read to complete the task.

${conventionContext}

Rules:
- Select only files that are directly relevant to the task
- Include files that might need modification AND files needed for context (imports, types, etc.)
- If the task requires creating new files, list them in filesToCreate
- Keep the list focused — prefer fewer, more relevant files over many tangential ones
- Maximum 20 files in relevantFiles`;

  const userMessage = [
    "## Task",
    prompt,
    "",
    "## Available Files",
    ...filePaths.map((f) => `- ${f}`),
  ].join("\n");

  const response = await gemini.chat({
    messages: [{ role: "user", content: userMessage }],
    systemInstruction,
    jsonSchema: PLAN_RESPONSE_SCHEMA,
    temperature: 0.1,
    maxTokens: 2048,
  });

  if (!response.content) {
    // Fallback: use first N files if planning fails
    return {
      approach: "Planning failed — using all discovered files",
      relevantFiles: filePaths.slice(0, MAX_FILES_TO_READ),
      filesToCreate: [],
    };
  }

  try {
    return JSON.parse(response.content);
  } catch {
    return {
      approach: "Planning response unparseable — using all discovered files",
      relevantFiles: filePaths.slice(0, MAX_FILES_TO_READ),
      filesToCreate: [],
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
        if (IGNORE_DIRS.has(entry.name)) continue;
        // Allow .claude directory (for tasks.md, docs) but skip other dotdirs
        if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
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

/**
 * Read convention files (CLAUDE.md, package.json, etc.) that provide
 * essential repo context. These are always included regardless of the plan.
 */
async function readConventionFiles(repoPath: string): Promise<Map<string, string>> {
  const contents = new Map<string, string>();

  for (const fileName of CONVENTION_FILES) {
    try {
      const fullPath = join(repoPath, fileName);
      const stats = await stat(fullPath);
      if (stats.size > MAX_FILE_SIZE) continue;
      const content = await readFile(fullPath, "utf-8");
      contents.set(fileName, content);
    } catch {
      // File doesn't exist — skip
    }
  }

  return contents;
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

function buildConventionContext(conventionContents: Map<string, string>): string {
  if (conventionContents.size === 0) return "";

  const parts: string[] = ["## Repository Conventions"];
  for (const [path, content] of conventionContents) {
    // For package.json, only include name, scripts, and dependencies keys
    if (path === "package.json") {
      try {
        const pkg = JSON.parse(content);
        const slim = {
          name: pkg.name,
          scripts: pkg.scripts,
          dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : undefined,
          devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : undefined,
        };
        parts.push(`### ${path}`, "```json", JSON.stringify(slim, null, 2), "```", "");
      } catch {
        parts.push(`### ${path}`, "```", content.slice(0, 2000), "```", "");
      }
    } else {
      parts.push(`### ${path}`, "```", content.slice(0, 3000), "```", "");
    }
  }

  return parts.join("\n");
}

const TASK_TYPE_GUIDANCE: Record<string, string> = {
  fix: "Identify the root cause of the bug before making changes. Focus on the minimal fix — do not refactor surrounding code.",
  feature: "Implement the feature following existing patterns in the codebase. Keep it minimal and focused.",
  refactor: "Improve code structure without changing behavior. Ensure all imports and references remain valid.",
  test: "Write tests following existing test patterns. Cover edge cases and error paths.",
  docs: "Update or add documentation. Follow existing doc style and conventions.",
  investigate: "If investigation reveals a fix, implement it. Otherwise, add a clear comment explaining the finding.",
};

function buildSystemPrompt(
  taskType: string,
  conventionContents: Map<string, string>,
): string {
  const guidance = TASK_TYPE_GUIDANCE[taskType] ?? TASK_TYPE_GUIDANCE.feature;
  const conventionContext = buildConventionContext(conventionContents);

  return `You are a coding agent. Your task type is: ${taskType}.

You will receive a task description, an approach plan, and the contents of relevant source files.
Produce the necessary file changes to complete the task.

Task guidance: ${guidance}

${conventionContext}

Rules:
- Only modify files that need changes
- Return the COMPLETE content of each modified file (not diffs)
- Keep changes minimal and focused on the task
- Follow existing code style and conventions from the repository
- Do not add unnecessary dependencies
- Ensure the code compiles and is correct
- You MUST produce at least one file change — if you cannot complete the task, modify the most relevant file with a TODO comment explaining what needs to be done
- Do NOT modify .claude/tasks.md or any task management files`;
}

function buildUserMessage(
  prompt: string,
  approach: string,
  fileContents: Map<string, string>,
): string {
  const parts: string[] = [
    "## Task",
    prompt,
    "",
    "## Approach",
    approach,
    "",
    "## Source Files",
  ];

  for (const [path, content] of fileContents) {
    parts.push(`### ${path}`, "```", content, "```", "");
  }

  return parts.join("\n");
}
