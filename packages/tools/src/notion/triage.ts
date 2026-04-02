import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { NotionTask } from "./client.js";
import { getProjectMapping } from "./config.js";

export interface TriageResult {
  canExecute: boolean;
  reason: string;
  subtasks: string[];
}

const TRIAGE_PROMPT = `You are a task sizing assistant for an AI coding agent (Claude Code).
Given a software task and project context, determine if it can be completed in a single 10-minute session.

Rules:
- Tasks that involve modifying 1-3 files with clear scope → CAN execute
- Tasks that are vague, multi-phase, require research, or touch many files → CANNOT execute
- Bug fixes, small features, config changes, documentation updates → usually CAN execute
- "Build entire feature", "refactor system", "generate content for multiple pages" → CANNOT execute
- Use the project context (file structure, stack, architecture docs) to make an informed decision
- When decomposing, each subtask should be completable in one 10-minute session
- Each subtask should reference specific files or directories when possible

Respond in JSON format only:
{
  "canExecute": true/false,
  "reason": "one-line explanation",
  "subtasks": ["subtask 1", "subtask 2", ...] // only if canExecute is false, 3-5 concrete subtasks
}`;

/**
 * Gather project context for triage: CLAUDE.md, package.json, directory listing.
 * Reads whatever is available, skips missing files gracefully.
 */
async function gatherProjectContext(repoPath: string): Promise<string> {
  const sections: string[] = [];

  // 1. CLAUDE.md — best source of architecture and conventions
  const claudeMd = await readFile(join(repoPath, "CLAUDE.md"), "utf-8").catch(() => null);
  if (claudeMd) {
    // Truncate to keep prompt size reasonable
    sections.push(`## CLAUDE.md\n${claudeMd.slice(0, 3000)}`);
  }

  // 2. package.json or build file — stack, dependencies, scripts
  const pkgJson = await readFile(join(repoPath, "package.json"), "utf-8").catch(() => null);
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson) as Record<string, unknown>;
      const summary = {
        name: pkg["name"],
        scripts: pkg["scripts"] ? Object.keys(pkg["scripts"] as Record<string, unknown>) : [],
        dependencies: pkg["dependencies"] ? Object.keys(pkg["dependencies"] as Record<string, unknown>) : [],
      };
      sections.push(`## package.json (summary)\n${JSON.stringify(summary, null, 2)}`);
    } catch {
      sections.push(`## package.json\n${pkgJson.slice(0, 500)}`);
    }
  }

  // Kotlin/Gradle project
  const buildGradle = await readFile(join(repoPath, "app/build.gradle.kts"), "utf-8").catch(() => null);
  if (buildGradle && !pkgJson) {
    sections.push(`## build.gradle.kts\n${buildGradle.slice(0, 1000)}`);
  }

  // 3. Top-level directory listing
  try {
    const entries = await readdir(repoPath);
    const filtered = entries.filter((e) => !e.startsWith(".") && e !== "node_modules");
    sections.push(`## Directory listing\n${filtered.join(", ")}`);
  } catch {
    // Skip if unreadable
  }

  // 4. .claude/docs/ — design specs and architecture docs
  try {
    const claudeDocs = await readdir(join(repoPath, ".claude/docs"));
    if (claudeDocs.length > 0) {
      sections.push(`## .claude/docs/ files\n${claudeDocs.join(", ")}`);
      // Read first doc for extra context (usually the most relevant)
      const firstDoc = await readFile(join(repoPath, ".claude/docs", claudeDocs[0]!), "utf-8").catch(() => null);
      if (firstDoc) {
        sections.push(`## .claude/docs/${claudeDocs[0]} (excerpt)\n${firstDoc.slice(0, 1500)}`);
      }
    }
  } catch {
    // No .claude/docs/ directory
  }

  // 5. docs/ — project documentation
  try {
    const docsEntries = await readdir(join(repoPath, "docs"));
    if (docsEntries.length > 0) {
      sections.push(`## docs/ files\n${docsEntries.join(", ")}`);
    }
  } catch {
    // No docs/ directory
  }

  // 6. README.md — project purpose (brief excerpt)
  const readme = await readFile(join(repoPath, "README.md"), "utf-8").catch(() => null);
  if (readme && !claudeMd) {
    // Only include README if there's no CLAUDE.md (avoid redundancy)
    sections.push(`## README.md (excerpt)\n${readme.slice(0, 1000)}`);
  }

  return sections.length > 0
    ? sections.join("\n\n")
    : "No project context available.";
}

/**
 * Use Gemini to triage whether a task is small enough for a single
 * Claude Code session, or needs to be broken into subtasks.
 * Reads project context (CLAUDE.md, package.json, file tree) for informed decisions.
 */
export async function triageTask(task: NotionTask): Promise<TriageResult> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    return { canExecute: true, reason: "Triage skipped (no GEMINI_API_KEY)", subtasks: [] };
  }

  // Gather project context if we have a repo mapping
  let projectContext = "No project context available.";
  const mapping = getProjectMapping(task.project);
  if (mapping) {
    projectContext = await gatherProjectContext(mapping.repoPath);
  }

  const client = new GoogleGenAI({ apiKey });

  const taskDescription = [
    `Task: ${task.title}`,
    task.type ? `Type: ${task.type}` : "",
    task.project ? `Project: ${task.project}` : "",
    task.filePath ? `Focus file/dir: ${task.filePath}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const fullPrompt = [
    TRIAGE_PROMPT,
    "",
    "--- PROJECT CONTEXT ---",
    projectContext,
    "",
    "--- TASK TO EVALUATE ---",
    taskDescription,
  ].join("\n");

  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: fullPrompt,
      config: {
        temperature: 0.1,
        maxOutputTokens: 500,
        responseMimeType: "application/json",
      },
    });

    const text = response.text?.trim() ?? "";
    // Gemini sometimes wraps in markdown code blocks or uses thinking tags
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/, "")
      .replace(/^[\s\S]*?(\{)/m, "$1") // strip everything before first {
      .replace(/\}[\s\S]*$/, "}") // strip everything after last }
      .trim();
    console.log("[triage] Gemini response:", cleaned.slice(0, 200));
    const parsed = JSON.parse(cleaned) as TriageResult;

    return {
      canExecute: Boolean(parsed.canExecute),
      reason: String(parsed.reason ?? ""),
      subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks.map(String) : [],
    };
  } catch (err) {
    // On any triage failure, default to attempting execution
    console.error("[triage] Gemini triage failed, allowing execution:", err);
    return { canExecute: true, reason: "Triage failed, attempting execution", subtasks: [] };
  }
}
