import { existsSync } from "node:fs";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { GeminiProvider } from "@cherryagent/core";
import {
  getDefaultProjectMappings,
  detectTaskType,
  generateBranchName,
  generatePrTitle,
  runGeminiAgent,
  createBranchAndPush,
  pushExistingBranch,
  createDraftPr,
  mergePr,
  closePr,
  remoteBranchExists,
  getActiveSession,
  createSession,
  updateSession,
  deleteSession,
  getPendingTask,
  setPendingTask,
  updatePendingTask,
  deletePendingTask,
  logCost,
} from "@cherryagent/tools";
import type { VoiceIntent } from "@cherryagent/tools";
import { escapeHtml } from "../utils.js";

interface VoiceHandlerDeps {
  gemini: GeminiProvider;
  botToken: string;
  costConfig?: {
    timezone?: string;
    dailyCapUsd?: number;
    monthlyCapUsd?: number;
  };
}

export function createVoiceHandlers(deps: VoiceHandlerDeps) {
  const { gemini, botToken } = deps;

  // ─── Voice message entry point ────────────────────────────────

  async function handleVoice(ctx: Context) {
    const voice = ctx.message?.voice;
    if (!voice) return;

    const chatId = String(ctx.chat?.id);

    // Check for active session (follow-up voice note)
    const existingSession = getActiveSession(chatId);

    await ctx.reply("🎙️ Processing voice message…");

    try {
      // 1. Download the .ogg file
      const file = await ctx.api.getFile(voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) {
        return ctx.reply("Failed to download voice message.");
      }
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      // 2. Transcribe with Gemini Flash
      const transcription = await gemini.transcribeAudio({
        audioBuffer,
        mimeType: "audio/ogg",
      });

      const transcript = transcription.content?.trim();
      if (!transcript) {
        return ctx.reply("Could not transcribe voice message. Please try again.");
      }

      // Track transcription cost
      const costUsd =
        (transcription.usage.inputTokens * gemini.inputCostPer1M +
          transcription.usage.outputTokens * gemini.outputCostPer1M) /
        1_000_000;
      await logCost(
        "voice-transcription",
        gemini.id,
        costUsd,
        `${transcription.usage.inputTokens} in / ${transcription.usage.outputTokens} out`,
        deps.costConfig?.timezone,
      );

      // 3. Follow-up on existing session — skip approval flow
      if (existingSession) {
        await ctx.reply(
          `📝 <b>Transcript:</b>\n<blockquote>${escapeHtml(transcript)}</blockquote>`,
          { parse_mode: "HTML" },
        );
        return handleFollowUp(ctx, existingSession, transcript);
      }

      // 4. Show transcript and ask for approval
      setPendingTask({
        chatId,
        transcript,
        state: "awaiting_transcript_approval",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const keyboard = new InlineKeyboard()
        .text("✅ Approve", "voice_approve")
        .text("✏️ Edit", "voice_edit")
        .text("❌ Cancel", "voice_cancel");

      await ctx.reply(
        `📝 <b>Transcript:</b>\n<blockquote>${escapeHtml(transcript)}</blockquote>\n\n` +
          "Does this look correct?",
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      console.error("[voice] Pipeline error:", err);
      deletePendingTask(chatId);
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(
        `❌ Voice pipeline error:\n<pre>${escapeHtml(message).slice(0, 300)}</pre>`,
        { parse_mode: "HTML" },
      );
    }
  }

  // ─── Text handler for transcript edits ────────────────────────

  async function handleVoiceText(ctx: Context): Promise<boolean> {
    const chatId = String(ctx.chat?.id);
    const pending = getPendingTask(chatId);

    if (!pending || pending.state !== "awaiting_transcript_edit") {
      return false; // Not a voice edit — let other handlers process
    }

    const newTranscript = ctx.message?.text?.trim();
    if (!newTranscript) return false;

    // Update transcript and go back to approval
    updatePendingTask(chatId, {
      transcript: newTranscript,
      state: "awaiting_transcript_approval",
    });

    const keyboard = new InlineKeyboard()
      .text("✅ Approve", "voice_approve")
      .text("✏️ Edit", "voice_edit")
      .text("❌ Cancel", "voice_cancel");

    await ctx.reply(
      `📝 <b>Updated transcript:</b>\n<blockquote>${escapeHtml(newTranscript)}</blockquote>\n\n` +
        "Does this look correct?",
      { parse_mode: "HTML", reply_markup: keyboard },
    );

    return true; // Handled
  }

  // ─── Callback router ─────────────────────────────────────────

  async function handleVoiceCallback(ctx: Context) {
    const data = ctx.callbackQuery?.data ?? "";
    const chatId = String(ctx.callbackQuery?.message?.chat.id);

    // Transcript approval flow
    if (data === "voice_approve") return handleApprove(ctx, chatId);
    if (data === "voice_edit") return handleEdit(ctx, chatId);
    if (data === "voice_cancel") return handleCancel(ctx, chatId);

    // Project selection
    if (data.startsWith("voice_project_")) {
      const slug = data.replace("voice_project_", "");
      return handleProjectSelected(ctx, chatId, slug);
    }

    // Confirmation
    if (data === "voice_go") return handleGo(ctx, chatId);

    // Active session actions
    if (data === "voice_merge") return handleMergeAction(ctx, chatId);
    if (data === "voice_close") return handleCloseAction(ctx, chatId);
    if (data === "voice_newtask") {
      deleteSession(chatId);
      deletePendingTask(chatId);
      await ctx.answerCallbackQuery({ text: "Session cleared!" });
      return ctx.reply("🎙️ Session reset. Send a new voice note to start a fresh task.");
    }
    if (data === "voice_followup") {
      await ctx.answerCallbackQuery({ text: "Send another voice note to follow up!" });
      return ctx.reply("🎙️ Send a voice note to continue working on this task.");
    }

    await ctx.answerCallbackQuery();
  }

  // ─── Transcript approval handlers ─────────────────────────────

  async function handleApprove(ctx: Context, chatId: string) {
    const pending = getPendingTask(chatId);
    if (!pending || pending.state !== "awaiting_transcript_approval") {
      await ctx.answerCallbackQuery({ text: "Expired or wrong state." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Transcript approved!" });

    // Show project selection buttons
    updatePendingTask(chatId, { state: "awaiting_project_selection" });

    const mappings = getDefaultProjectMappings();
    const available = mappings.filter((m) => existsSync(m.repoPath));

    if (available.length === 0) {
      deletePendingTask(chatId);
      return ctx.reply(
        "No project repos found. Check VOICE_REPO_BASE_PATH env var.",
      );
    }

    const keyboard = new InlineKeyboard();
    for (const mapping of available) {
      keyboard.text(projectIcon(mapping.slug) + " " + mapping.slug, `voice_project_${mapping.slug}`).row();
    }
    keyboard.text("❌ Cancel", "voice_cancel");

    await ctx.reply("Which project is this for?", { reply_markup: keyboard });
  }

  async function handleEdit(ctx: Context, chatId: string) {
    const pending = getPendingTask(chatId);
    if (!pending || pending.state !== "awaiting_transcript_approval") {
      await ctx.answerCallbackQuery({ text: "Expired or wrong state." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Send the corrected text." });
    updatePendingTask(chatId, { state: "awaiting_transcript_edit" });

    await ctx.reply(
      "✏️ Send a text message with the corrected task description.\n\n" +
        `Current:\n<blockquote>${escapeHtml(pending.transcript)}</blockquote>`,
      { parse_mode: "HTML" },
    );
  }

  async function handleCancel(ctx: Context, chatId: string) {
    deletePendingTask(chatId);
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.reply("Cancelled. Send a new voice note to start over.");
  }

  // ─── Project selection handler ────────────────────────────────

  async function handleProjectSelected(ctx: Context, chatId: string, slug: string) {
    const pending = getPendingTask(chatId);
    if (!pending || pending.state !== "awaiting_project_selection") {
      await ctx.answerCallbackQuery({ text: "No pending task found." });
      return;
    }

    const mappings = getDefaultProjectMappings();
    const mapping = mappings.find((m) => m.slug === slug);
    if (!mapping) {
      await ctx.answerCallbackQuery({ text: "Project not found." });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Selected: ${slug}` });

    // Detect task type and generate branch/PR info
    const taskType = detectTaskType(pending.transcript);
    const branchName = generateBranchName(taskType, pending.transcript);
    const prTitle = generatePrTitle(taskType, pending.transcript);

    updatePendingTask(chatId, {
      state: "awaiting_confirmation",
      project: slug,
      repoPath: mapping.repoPath,
      taskType,
      branchName,
      prTitle,
    });

    const keyboard = new InlineKeyboard()
      .text("✅ Go", "voice_go")
      .text("❌ Cancel", "voice_cancel");

    await ctx.reply(
      `🎯 <b>Ready to run</b>\n\n` +
        `<b>Project:</b> ${projectIcon(slug)} ${escapeHtml(slug)}\n` +
        `<b>Type:</b> ${taskType}\n` +
        `<b>Branch:</b> <code>${escapeHtml(branchName)}</code>\n\n` +
        `<blockquote>${escapeHtml(pending.transcript.slice(0, 200))}</blockquote>`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  }

  // ─── Execute the task ─────────────────────────────────────────

  async function handleGo(ctx: Context, chatId: string) {
    const pending = getPendingTask(chatId);
    if (
      !pending ||
      pending.state !== "awaiting_confirmation" ||
      !pending.project ||
      !pending.repoPath ||
      !pending.taskType ||
      !pending.branchName ||
      !pending.prTitle
    ) {
      await ctx.answerCallbackQuery({ text: "No confirmed task to run." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Running agent…" });
    deletePendingTask(chatId);

    const intent: VoiceIntent = {
      project: pending.project,
      repoPath: pending.repoPath,
      taskType: pending.taskType,
      branchName: pending.branchName,
      prTitle: pending.prTitle,
      taskDescription: pending.transcript,
      transcript: pending.transcript,
    };

    await runVoicePipeline(ctx, chatId, intent);
  }

  // ─── Core pipeline (shared between new task and follow-up) ────

  async function runVoicePipeline(ctx: Context, chatId: string, intent: VoiceIntent) {
    try {
      await ctx.reply("⏳ Running Gemini agent…");
      const result = await runGeminiAgent({
        gemini,
        repoPath: intent.repoPath,
        prompt: intent.taskDescription,
        taskType: intent.taskType,
      });

      if (!result.success) {
        return ctx.reply(
          `❌ Agent failed:\n<pre>${escapeHtml(result.error ?? result.output).slice(0, 500)}</pre>`,
          { parse_mode: "HTML" },
        );
      }

      // Track agent cost
      if (result.usage) {
        const agentCost =
          (result.usage.inputTokens * gemini.inputCostPer1M +
            result.usage.outputTokens * gemini.outputCostPer1M) /
          1_000_000;
        await logCost(
          "voice-agent",
          gemini.id,
          agentCost,
          `${result.usage.inputTokens} in / ${result.usage.outputTokens} out`,
          deps.costConfig?.timezone,
        );
      }

      if (result.filesChanged === 0) {
        return ctx.reply("Agent ran but made no changes.");
      }

      // Create branch, commit, push
      const pushed = await createBranchAndPush({
        repoPath: intent.repoPath,
        branchName: intent.branchName,
        commitMessage: `${intent.prTitle}\n\nVoice transcript: ${intent.transcript}`,
      });

      if (!pushed) {
        return ctx.reply("No changes to push after agent ran.");
      }

      // Create draft PR
      const pr = await createDraftPr({
        repoPath: intent.repoPath,
        title: intent.prTitle,
        body: formatPrBody(intent.transcript, result.output),
      });

      if (!pr.success) {
        return ctx.reply(
          `❌ PR creation failed: ${escapeHtml(pr.error ?? "unknown error")}\n\n` +
            `Branch <code>${escapeHtml(intent.branchName)}</code> was pushed — create PR manually.`,
          { parse_mode: "HTML" },
        );
      }

      // Store session for follow-ups
      createSession({
        chatId,
        project: intent.project,
        repoPath: intent.repoPath,
        branchName: intent.branchName,
        prNumber: pr.prNumber,
        prUrl: pr.prUrl,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await sendTaskComplete(ctx, intent, result.filesChanged, pr.prUrl);
    } catch (err) {
      console.error("[voice] Pipeline error:", err);
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(
        `❌ Voice pipeline error:\n<pre>${escapeHtml(message).slice(0, 300)}</pre>`,
        { parse_mode: "HTML" },
      );
    }
  }

  // ─── Follow-up on existing session ────────────────────────────

  async function handleFollowUp(
    ctx: Context,
    session: ReturnType<typeof getActiveSession> & object,
    transcript: string,
  ) {
    const branchExists = await remoteBranchExists(session.repoPath, session.branchName);
    if (!branchExists) {
      deleteSession(session.chatId);
      return ctx.reply(
        `Branch <code>${escapeHtml(session.branchName)}</code> no longer exists. Session cleared.\n` +
          "Send a new voice note to start a fresh task.",
        { parse_mode: "HTML" },
      );
    }

    await ctx.reply(
      `🔄 Follow-up on <b>${escapeHtml(session.project)}</b> / <code>${escapeHtml(session.branchName)}</code>`,
      { parse_mode: "HTML" },
    );

    await ctx.reply("⏳ Running Gemini agent (follow-up)…");

    const result = await runGeminiAgent({
      gemini,
      repoPath: session.repoPath,
      prompt: transcript,
      taskType: "feature",
    });

    if (!result.success) {
      return ctx.reply(
        `❌ Agent failed:\n<pre>${escapeHtml(result.error ?? result.output).slice(0, 500)}</pre>`,
        { parse_mode: "HTML" },
      );
    }

    if (result.usage) {
      const agentCost =
        (result.usage.inputTokens * gemini.inputCostPer1M +
          result.usage.outputTokens * gemini.outputCostPer1M) /
        1_000_000;
      await logCost(
        "voice-agent",
        gemini.id,
        agentCost,
        `follow-up: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`,
        deps.costConfig?.timezone,
      );
    }

    if (result.filesChanged > 0) {
      await pushExistingBranch({
        repoPath: session.repoPath,
        commitMessage: `follow-up: ${transcript.slice(0, 72)}`,
      });
    }

    updateSession(session.chatId, { updatedAt: Date.now() });

    const summary = result.output.slice(0, 300);
    await ctx.reply(
      `✅ <b>Follow-up complete</b>\n` +
        `Files changed: ${result.filesChanged}\n\n` +
        `<blockquote>${escapeHtml(summary)}</blockquote>` +
        (session.prUrl ? `\n\n<a href="${session.prUrl}">View PR</a>` : ""),
      { parse_mode: "HTML" },
    );
  }

  // ─── /voicereset command ──────────────────────────────────────

  async function handleVoiceReset(ctx: Context) {
    const chatId = String(ctx.chat?.id);
    const session = getActiveSession(chatId);
    const pending = getPendingTask(chatId);

    if (!session && !pending) {
      return ctx.reply("No active voice session to reset.");
    }

    deleteSession(chatId);
    deletePendingTask(chatId);

    if (session) {
      return ctx.reply(
        `Session cleared for <b>${escapeHtml(session.project)}</b> / <code>${escapeHtml(session.branchName)}</code>.\n` +
          "Send a new voice note to start a fresh task.",
        { parse_mode: "HTML" },
      );
    }

    return ctx.reply("Pending task cleared. Send a new voice note to start over.");
  }

  // ─── Merge / Close actions ────────────────────────────────────

  async function handleMergeAction(ctx: Context, chatId: string) {
    const session = getActiveSession(chatId);
    if (!session?.prNumber) {
      await ctx.answerCallbackQuery({ text: "No active PR to merge." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Merging PR…" });

    const result = await mergePr({
      repoPath: session.repoPath,
      prNumber: session.prNumber,
    });

    deleteSession(chatId);

    if (result.success) {
      await ctx.editMessageText(
        `✅ <b>PR #${session.prNumber} merged!</b>\nBranch <code>${escapeHtml(session.branchName)}</code> deleted.`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(
        `❌ Merge failed: ${escapeHtml(result.error ?? "unknown error")}`,
        { parse_mode: "HTML" },
      );
    }
  }

  async function handleCloseAction(ctx: Context, chatId: string) {
    const session = getActiveSession(chatId);
    if (!session?.prNumber) {
      await ctx.answerCallbackQuery({ text: "No active PR to close." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Closing PR…" });

    const result = await closePr({
      repoPath: session.repoPath,
      prNumber: session.prNumber,
      branchName: session.branchName,
    });

    deleteSession(chatId);

    if (result.success) {
      await ctx.editMessageText(
        `❌ <b>PR #${session.prNumber} closed.</b>\nBranch <code>${escapeHtml(session.branchName)}</code> cleaned up.`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(
        `❌ Close failed: ${escapeHtml(result.error ?? "unknown error")}`,
        { parse_mode: "HTML" },
      );
    }
  }

  return { handleVoice, handleVoiceText, handleVoiceCallback, handleVoiceReset };
}

// ─── Helpers ──────────────────────────────────────────────────

const PROJECT_ICONS: Record<string, string> = {
  cherryagent: "🍒",
  cherrytree: "🌳",
  fincherry: "💰",
  saminprogress: "💬",
  surpride: "🏳️‍🌈",
};

function projectIcon(slug: string): string {
  return PROJECT_ICONS[slug] ?? "📁";
}

function sendTaskComplete(
  ctx: Context,
  intent: VoiceIntent,
  filesChanged: number,
  prUrl: string | null,
) {
  const lines = [
    "<b>✅ Task Complete</b>",
    "",
    `<b>Project:</b> ${projectIcon(intent.project)} ${escapeHtml(intent.project)}`,
    `<b>Branch:</b> <code>${escapeHtml(intent.branchName)}</code>`,
    `<b>Files changed:</b> ${filesChanged}`,
    "",
    `<blockquote>${escapeHtml(intent.taskDescription.slice(0, 200))}</blockquote>`,
  ];

  const keyboard = new InlineKeyboard();

  if (prUrl) {
    keyboard.url("🔗 View PR", prUrl).row();
  }

  keyboard
    .text("✅ Merge", "voice_merge")
    .text("❌ Close", "voice_close")
    .row()
    .text("💬 Follow Up", "voice_followup")
    .text("🔄 New Task", "voice_newtask");

  return ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

function formatPrBody(transcript: string, agentOutput: string): string {
  const summary = agentOutput.slice(0, 500);
  return [
    "## Voice Task",
    "",
    "**Transcript:**",
    `> ${transcript}`,
    "",
    "**Agent output:**",
    "```",
    summary,
    "```",
    "",
    "---",
    "*Created by CherryAgent voice pipeline* 🍒🎙️",
  ].join("\n");
}
