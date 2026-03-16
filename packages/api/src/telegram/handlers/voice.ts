import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { GeminiProvider } from "@cherryagent/core";
import {
  parseIntent,
  runClaudeCode,
  createBranchAndPush,
  pushExistingBranch,
  createDraftPr,
  mergePr,
  closePr,
  getActiveSession,
  createSession,
  updateSession,
  deleteSession,
  logCost,
} from "@cherryagent/tools";
import type { VoiceIntent } from "@cherryagent/tools";

interface VoiceHandlerDeps {
  gemini: GeminiProvider;
  botToken: string;
  costConfig?: {
    timezone?: string;
    dailyCapUsd?: number;
    monthlyCapUsd?: number;
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function createVoiceHandlers(deps: VoiceHandlerDeps) {
  const { gemini, botToken } = deps;

  /**
   * Handle incoming voice messages — main entry point.
   */
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

      await ctx.reply(
        `📝 <b>Transcript:</b>\n<blockquote>${escapeHtml(transcript)}</blockquote>`,
        { parse_mode: "HTML" },
      );

      // 3. Follow-up on existing session or parse new intent
      if (existingSession) {
        return handleFollowUp(ctx, existingSession, transcript);
      }

      // 4. Parse intent
      const intent = parseIntent(transcript);
      if (!intent) {
        return ctx.reply(
          "Could not identify a project from the transcript.\n\n" +
            "Mention a project name: cherrytree, surpride, fincherry, blog, cherryagent",
        );
      }

      await ctx.reply(
        `🎯 <b>${escapeHtml(intent.project)}</b> — ${intent.taskType}\n` +
          `Branch: <code>${escapeHtml(intent.branchName)}</code>`,
        { parse_mode: "HTML" },
      );

      // 5. Run Claude Code
      await ctx.reply("⏳ Running Claude Code…");
      const result = await runClaudeCode({
        repoPath: intent.repoPath,
        prompt: intent.taskDescription,
      });

      if (!result.success) {
        return ctx.reply(
          `❌ Claude Code failed:\n<pre>${escapeHtml(result.error ?? result.output).slice(0, 500)}</pre>`,
          { parse_mode: "HTML" },
        );
      }

      if (result.filesChanged === 0) {
        return ctx.reply("Claude Code ran but made no changes.");
      }

      // 6. Create branch, commit, push
      const pushed = await createBranchAndPush({
        repoPath: intent.repoPath,
        branchName: intent.branchName,
        commitMessage: `${intent.prTitle}\n\nVoice transcript: ${transcript}`,
      });

      if (!pushed) {
        return ctx.reply("No changes to push after Claude Code ran.");
      }

      // 7. Create draft PR
      const pr = await createDraftPr({
        repoPath: intent.repoPath,
        title: intent.prTitle,
        body: formatPrBody(transcript, result.output),
      });

      // 8. Store session for follow-ups
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

      // 9. Send formatted response with inline keyboard
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

  /**
   * Handle follow-up voice notes on an existing session.
   */
  async function handleFollowUp(
    ctx: Context,
    session: ReturnType<typeof getActiveSession> & object,
    transcript: string,
  ) {
    await ctx.reply(
      `🔄 Follow-up on <b>${escapeHtml(session.project)}</b> / <code>${escapeHtml(session.branchName)}</code>`,
      { parse_mode: "HTML" },
    );

    await ctx.reply("⏳ Running Claude Code (follow-up)…");

    const result = await runClaudeCode({
      repoPath: session.repoPath,
      prompt: transcript,
    });

    if (!result.success) {
      return ctx.reply(
        `❌ Claude Code failed:\n<pre>${escapeHtml(result.error ?? result.output).slice(0, 500)}</pre>`,
        { parse_mode: "HTML" },
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

  /**
   * Handle inline keyboard button presses for voice tasks.
   */
  async function handleVoiceCallback(ctx: Context) {
    const data = ctx.callbackQuery?.data ?? "";
    const chatId = String(ctx.callbackQuery?.message?.chat.id);

    if (data === "voice_merge") {
      return handleMergeAction(ctx, chatId);
    }
    if (data === "voice_close") {
      return handleCloseAction(ctx, chatId);
    }
    if (data === "voice_followup") {
      await ctx.answerCallbackQuery({
        text: "Send another voice note to follow up!",
      });
      return ctx.reply("🎙️ Send a voice note to continue working on this task.");
    }

    await ctx.answerCallbackQuery();
  }

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

  return { handleVoice, handleVoiceCallback };
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
    `<b>Project:</b> ${escapeHtml(intent.project)}`,
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
    .text("💬 Follow Up", "voice_followup");

  return ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

function formatPrBody(transcript: string, claudeOutput: string): string {
  const summary = claudeOutput.slice(0, 500);
  return [
    "## Voice Task",
    "",
    "**Transcript:**",
    `> ${transcript}`,
    "",
    "**Claude Code output:**",
    "```",
    summary,
    "```",
    "",
    "---",
    "*Created by CherryAgent voice pipeline* 🍒🎙️",
  ].join("\n");
}
