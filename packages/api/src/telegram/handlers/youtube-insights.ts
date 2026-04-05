import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { GeminiProvider } from "@cherryagent/core";
import { YOUTUBE_INSIGHTS_SYSTEM_PROMPT } from "@cherryagent/core";
import { readBrainContext, logCost, checkSpendWarning } from "@cherryagent/tools";

// ─── File-backed state (survives container restarts) ────────────

export interface InsightsPendingState {
  chatId: string;
  videoTitle: string;
  videoAuthor: string;
  notes: string;
  questionIndex: number; // -1 = not started, 0-3 = awaiting answer for that Q
  answers: string[];
  createdAt: number;
}

/** 1 hour timeout for pending insights interviews */
const INSIGHTS_TIMEOUT_MS = 60 * 60 * 1000;

function getStatePath(): string {
  const home = process.env["HOME"] ?? ".";
  return join(home, ".cherryagent", "yt-insights-pending.json");
}

export function setInsightsPending(state: InsightsPendingState): void {
  const path = getStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state), "utf-8");
}

function getInsightsPending(chatId: string): InsightsPendingState | null {
  try {
    const data = readFileSync(getStatePath(), "utf-8");
    const state: InsightsPendingState = JSON.parse(data);
    if (state.chatId !== chatId) return null;
    if (Date.now() - state.createdAt > INSIGHTS_TIMEOUT_MS) {
      deleteInsightsPending();
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function saveInsightsPending(state: InsightsPendingState): void {
  writeFileSync(getStatePath(), JSON.stringify(state), "utf-8");
}

function deleteInsightsPending(): void {
  try {
    unlinkSync(getStatePath());
  } catch {
    // already gone
  }
}

// ─── Interview questions ────────────────────────────────────────

const INTERVIEW_QUESTIONS = [
  "What are you currently working on that this video might relate to?",
  "What specific problems or decisions are you facing that this content could inform?",
  "Any concepts or techniques from the notes you want me to dig deeper on?",
  "How do you see this applying — immediate action, future reference, or inspiration?",
];

// ─── Handler factory ────────────────────────────────────────────

interface InsightsDeps {
  gemini: GeminiProvider;
  costConfig?: { timezone?: string; dailyCapUsd?: number; monthlyCapUsd?: number };
}

export function createInsightsHandlers(deps: InsightsDeps) {
  const { gemini } = deps;

  /** Handle the "Start deep analysis" callback button */
  async function handleCallback(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const state = getInsightsPending(chatId);

    if (!state) {
      await ctx.answerCallbackQuery({ text: "Session expired. Run /yt again." });
      return;
    }

    await ctx.answerCallbackQuery();

    // Start the interview — ask question 0
    state.questionIndex = 0;
    saveInsightsPending(state);
    await ctx.reply(
      `Deep analysis for "${state.videoTitle}"\n\n` +
      `Question 1/${INTERVIEW_QUESTIONS.length}:\n${INTERVIEW_QUESTIONS[0]}`,
    );
  }

  /**
   * Check if incoming text is an answer to an insights interview question.
   * Returns true if handled, false to let other handlers process the message.
   */
  async function handleText(ctx: Context): Promise<boolean> {
    const chatId = String(ctx.chat?.id);
    const state = getInsightsPending(chatId);

    if (!state || state.questionIndex < 0) return false;

    const text = ctx.message?.text?.trim();
    if (!text) return false;

    // Store the answer
    state.answers.push(text);

    const nextIndex = state.questionIndex + 1;

    if (nextIndex < INTERVIEW_QUESTIONS.length) {
      // Ask the next question
      state.questionIndex = nextIndex;
      saveInsightsPending(state);
      await ctx.reply(
        `Question ${nextIndex + 1}/${INTERVIEW_QUESTIONS.length}:\n${INTERVIEW_QUESTIONS[nextIndex]}`,
      );
      return true;
    }

    // All questions answered — generate insights
    await ctx.reply("All answers collected. Generating your insights doc...");
    deleteInsightsPending();

    try {
      const brainContext = await readBrainContext();

      const userContent = buildInsightsPrompt(state, brainContext);

      const response = await gemini.chat({
        systemInstruction: YOUTUBE_INSIGHTS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        maxTokens: 4096,
      });

      const insights = response.content ?? "Failed to generate insights.";
      const cost =
        (response.usage.inputTokens / 1_000_000) * gemini.inputCostPer1M +
        (response.usage.outputTokens / 1_000_000) * gemini.outputCostPer1M;

      // Deliver as text + .md file
      if (insights.length <= 4000) {
        await ctx.reply(insights);
      } else {
        await ctx.reply(insights.slice(0, 4000) + "\n\n...(see full doc in file)");
      }

      const filename = `${sanitizeFilename(state.videoTitle)} - Insights.md`;
      const file = new InputFile(Buffer.from(insights, "utf-8"), filename);
      await ctx.replyWithDocument(file, {
        caption: `Insights for "${state.videoTitle}"`,
      });

      // Log cost
      if (cost > 0) {
        await logCost("youtube-insights", "gemini", cost, `insights: ${state.videoTitle}`, deps.costConfig?.timezone);
        const warning = await checkSpendWarning(deps.costConfig);
        if (warning) await ctx.reply(warning);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Failed to generate insights: ${message}`);
    }

    return true;
  }

  return { handleCallback, handleText };
}

// ─── Helpers ────────────────────────────────────────────────────

function buildInsightsPrompt(state: InsightsPendingState, brainContext: string): string {
  const parts: string[] = [];

  parts.push(`## Video Notes\n\nTitle: "${state.videoTitle}" by ${state.videoAuthor}\n\n${state.notes}`);

  if (brainContext) {
    parts.push(`## Brain Context (about the user)\n\n${brainContext}`);
  }

  parts.push(
    `## Interview Answers\n\n` +
    INTERVIEW_QUESTIONS.map((q, i) =>
      `**Q: ${q}**\nA: ${state.answers[i] ?? "(no answer)"}`,
    ).join("\n\n"),
  );

  return parts.join("\n\n---\n\n");
}

function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
