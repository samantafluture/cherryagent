import { GoogleGenAI } from "@google/genai";
import type { NotionTask } from "./client.js";

export interface TriageResult {
  canExecute: boolean;
  reason: string;
  subtasks: string[];
}

const TRIAGE_PROMPT = `You are a task sizing assistant. Given a software task, determine if it can be completed by an AI coding agent in a single 10-minute session.

Rules:
- Tasks that involve modifying 1-3 files with clear scope → CAN execute
- Tasks that are vague, multi-phase, require research, or touch many files → CANNOT execute, split into subtasks
- Bug fixes, small features, config changes, documentation → usually CAN execute
- "Generate content", "build entire feature", "refactor system" → usually CANNOT execute

Respond in JSON format only:
{
  "canExecute": true/false,
  "reason": "one-line explanation",
  "subtasks": ["subtask 1", "subtask 2", ...] // only if canExecute is false, 3-5 concrete subtasks
}`;

/**
 * Use Gemini to triage whether a task is small enough for a single
 * Claude Code session, or needs to be broken into subtasks.
 */
export async function triageTask(task: NotionTask): Promise<TriageResult> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    // If no Gemini key, skip triage and let Claude Code try
    return { canExecute: true, reason: "Triage skipped (no GEMINI_API_KEY)", subtasks: [] };
  }

  const client = new GoogleGenAI({ apiKey });

  const taskDescription = [
    `Task: ${task.title}`,
    task.type ? `Type: ${task.type}` : "",
    task.project ? `Project: ${task.project}` : "",
    task.filePath ? `File: ${task.filePath}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `${TRIAGE_PROMPT}\n\nTask to evaluate:\n${taskDescription}`,
      config: {
        temperature: 0.1,
        maxOutputTokens: 500,
        responseMimeType: "application/json",
      },
    });

    const text = response.text?.trim() ?? "";
    const parsed = JSON.parse(text) as TriageResult;

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
