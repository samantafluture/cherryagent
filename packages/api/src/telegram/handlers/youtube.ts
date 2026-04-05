import { createReadStream } from "node:fs";
import type { Context } from "grammy";
import { InputFile, InlineKeyboard } from "grammy";
import type { GeminiProvider, GroqWhisperClient } from "@cherryagent/core";
import {
  YOUTUBE_NOTES_SYSTEM_PROMPT,
  YOUTUBE_NOTES_RICH_SYSTEM_PROMPT,
} from "@cherryagent/core";
import {
  isYouTubeUrl,
  validateYouTubeUrl,
  runYouTubePipeline,
  addFavorite,
  listFavorites,
  getFavoriteByIndex,
  removeFavoriteByIndex,
  logCost,
  checkSpendWarning,
} from "@cherryagent/tools";
import type { YouTubeMode, MediaConfig, ProgressStep } from "@cherryagent/tools";
import { setInsightsPending } from "./youtube-insights.js";

const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024; // 50MB

const VALID_MODES = new Set<YouTubeMode>(["full", "audio", "notes"]);
const SUBCOMMANDS = new Set(["save", "list", "pick", "rm"]);

const PROGRESS_LABELS: Record<ProgressStep, string> = {
  validating: "Validating URL...",
  downloading_video: "Downloading video...",
  downloading_audio: "Downloading audio...",
  extracting_audio: "Extracting audio...",
  transcribing: "Transcribing (Whisper)...",
  generating_notes: "Generating notes...",
  done: "Done!",
};

interface YouTubeDeps {
  whisper: GroqWhisperClient;
  gemini: GeminiProvider;
  mediaConfig: MediaConfig;
  costConfig?: { timezone?: string; dailyCapUsd?: number; monthlyCapUsd?: number };
}

export function createYouTubeHandlers(deps: YouTubeDeps) {
  const { whisper, gemini, mediaConfig } = deps;

  async function handleYtCommand(ctx: Context) {
    const text = (ctx.match as string | undefined)?.trim();
    if (!text) {
      return ctx.reply(
        "Usage: /yt [mode] [rich] <url>\n\n" +
        "Modes:\n" +
        "  full — video + audio + notes (default)\n" +
        "  audio — audio + notes only\n" +
        "  notes — notes only\n\n" +
        "Add \"rich\" to any mode for Gemini video-based notes:\n" +
        "  /yt rich <url> — full + Gemini video notes\n" +
        "  /yt notes rich <url> — notes only, Gemini video\n\n" +
        "Favorites:\n" +
        "  /yt save <url> — save for later\n" +
        "  /yt list — show saved videos\n" +
        "  /yt pick <#> [mode] [rich] — process a saved video\n" +
        "  /yt rm <#> — remove from list\n\n" +
        "Batch: send multiple URLs on separate lines",
      );
    }

    // Check for subcommands
    const firstToken = text.split(/\s+/)[0]!.toLowerCase();
    if (SUBCOMMANDS.has(firstToken)) {
      const rest = text.slice(firstToken.length).trim();
      switch (firstToken) {
        case "save": return handleSave(ctx, rest);
        case "list": return handleList(ctx);
        case "pick": return handlePick(ctx, rest);
        case "rm": return handleRemove(ctx, rest);
      }
    }

    // Parse URLs, mode, and rich flag from the input
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const urls: string[] = [];
    let mode: YouTubeMode = "full";
    let rich = false;

    for (const line of lines) {
      const parts = line.split(/\s+/);
      for (const part of parts) {
        const lower = part.toLowerCase();
        if (isYouTubeUrl(part)) {
          urls.push(part);
        } else if (lower === "rich") {
          rich = true;
        } else if (VALID_MODES.has(lower as YouTubeMode)) {
          mode = lower as YouTubeMode;
        }
      }
    }

    if (urls.length === 0) {
      return ctx.reply("No valid YouTube URL found. Send a youtube.com or youtu.be link.");
    }

    // Process each URL sequentially
    for (const url of urls) {
      await processOneUrl(ctx, url, mode, rich);
    }
  }

  async function handleSave(ctx: Context, rest: string) {
    const url = rest.split(/\s+/).find((p) => isYouTubeUrl(p));
    if (!url) {
      return ctx.reply("Usage: /yt save <url>");
    }

    try {
      const meta = await validateYouTubeUrl(url);
      const { item, alreadyExisted } = await addFavorite(
        url,
        meta.title,
        meta.authorName,
        meta.thumbnailUrl,
      );
      const label = alreadyExisted ? "Already saved" : "Saved";
      return ctx.reply(`${label}: "${item.title}" by ${item.authorName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return ctx.reply(`Failed to save: ${message}`);
    }
  }

  async function handleList(ctx: Context) {
    const items = await listFavorites();
    if (items.length === 0) {
      return ctx.reply("No saved videos. Use /yt save <url> to add one.");
    }

    const lines = items.map((item, i) => {
      const date = new Date(item.savedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      return `${i + 1}. ${item.title}\n   ${item.authorName} · ${date}`;
    });

    return ctx.reply(lines.join("\n\n"));
  }

  async function handlePick(ctx: Context, rest: string) {
    const parts = rest.split(/\s+/).filter(Boolean);
    const index = Number(parts[0]);
    if (!index || index < 1) {
      return ctx.reply("Usage: /yt pick <#> [mode] [rich]");
    }

    let mode: YouTubeMode = "full";
    let rich = false;
    for (const p of parts.slice(1)) {
      const lower = p.toLowerCase();
      if (lower === "rich") rich = true;
      else if (VALID_MODES.has(lower as YouTubeMode)) mode = lower as YouTubeMode;
    }

    const item = await getFavoriteByIndex(index);
    if (!item) {
      return ctx.reply(`No saved video at #${index}. Use /yt list to see your list.`);
    }

    await processOneUrl(ctx, item.url, mode, rich);
  }

  async function handleRemove(ctx: Context, rest: string) {
    const index = Number(rest.trim());
    if (!index || index < 1) {
      return ctx.reply("Usage: /yt rm <#>");
    }

    const removed = await removeFavoriteByIndex(index);
    if (!removed) {
      return ctx.reply(`No saved video at #${index}. Use /yt list to see your list.`);
    }

    return ctx.reply(`Removed: "${removed.title}"`);
  }

  async function processOneUrl(ctx: Context, url: string, mode: YouTubeMode, rich: boolean) {
    // Send initial progress message
    const progressMsg = await ctx.reply("Processing YouTube URL...");
    const chatId = ctx.chat!.id;

    const updateProgress = async (step: ProgressStep, detail?: string) => {
      const label = PROGRESS_LABELS[step];
      const text = detail ? `${label}\n${detail}` : label;
      try {
        await ctx.api.editMessageText(chatId, progressMsg.message_id, text);
      } catch {
        // Edit may fail if text didn't change — ignore
      }
    };

    try {
      const result = await runYouTubePipeline(
        url,
        mode,
        rich,
        {
          whisper,
          llm: gemini,
          notesSystemPrompt: YOUTUBE_NOTES_SYSTEM_PROMPT,
          richNotesSystemPrompt: YOUTUBE_NOTES_RICH_SYSTEM_PROMPT,
        },
        mediaConfig,
        updateProgress,
      );

      // Update progress to done
      const doneText = [
        `Done! "${result.metadata.title}"`,
        `by ${result.metadata.authorName}`,
        result.metadata.durationSeconds
          ? `Duration: ${formatDuration(result.metadata.durationSeconds)}`
          : null,
        `Mode: ${mode}${rich ? " rich" : ""} | Cost: $${result.costUsd.toFixed(3)}`,
      ].filter(Boolean).join("\n");

      await ctx.api.editMessageText(chatId, progressMsg.message_id, doneText);

      // Log cost
      if (result.costUsd > 0) {
        await logCost("youtube", "gemini+groq", result.costUsd, `${mode}: ${result.metadata.title}`, deps.costConfig?.timezone);
        const warning = await checkSpendWarning(deps.costConfig);
        if (warning) await ctx.reply(warning);
      }

      const title = result.metadata.title;

      // Deliver video
      if (result.videoPath) {
        await deliverFile(ctx, result.videoPath, result.videoSizeBytes ?? 0, "video", title);
      }

      // Deliver audio
      if (result.audioPath) {
        await deliverFile(ctx, result.audioPath, result.audioSizeBytes ?? 0, "audio", title);
      }

      // Deliver notes
      if (result.notes) {
        // Send as text message (truncate if too long)
        if (result.notes.length <= 4000) {
          await ctx.reply(result.notes);
        } else {
          await ctx.reply(result.notes.slice(0, 4000) + "\n\n…(truncated, see full notes in file)");
        }

        // Always send as .md file
        const notesBuffer = Buffer.from(result.notes, "utf-8");
        const notesFilename = `${sanitizeFilename(title)} - Notes.md`;
        const file = new InputFile(notesBuffer, notesFilename);
        await ctx.replyWithDocument(file, {
          caption: `Notes for "${title}"`,
        });

        // Offer deep analysis via insights pipeline
        setInsightsPending({
          chatId: String(chatId),
          videoTitle: title,
          videoAuthor: result.metadata.authorName,
          notes: result.notes,
          questionIndex: -1,
          answers: [],
          createdAt: Date.now(),
        });

        const insightsKeyboard = new InlineKeyboard()
          .text("\ud83d\udd0d Start deep analysis", "yt_insights_start");
        await ctx.reply(
          "Want me to cross-reference this with your projects and produce actionable insights?",
          { reply_markup: insightsKeyboard },
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        chatId,
        progressMsg.message_id,
        `Failed to process video:\n${message}`,
      );
    }
  }

  async function deliverFile(
    ctx: Context,
    filePath: string,
    sizeBytes: number,
    type: "video" | "audio",
    title: string,
  ) {
    if (sizeBytes > TELEGRAM_FILE_LIMIT) {
      await ctx.reply(
        `${type === "video" ? "Video" : "Audio"} file is ${Math.round(sizeBytes / 1024 / 1024)}MB ` +
        `(exceeds Telegram's 50MB limit). File saved at: ${filePath}`,
      );
      return;
    }

    const ext = type === "video" ? ".mp4" : ".mp3";
    const filename = `${sanitizeFilename(title)}${ext}`;
    const stream = createReadStream(filePath);
    const file = new InputFile(stream, filename);

    if (type === "video") {
      await ctx.replyWithVideo(file);
    } else {
      await ctx.replyWithAudio(file, { title });
    }
  }

  return { handleYtCommand };
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Produce a safe filename from a video title, preserving readability. */
function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
