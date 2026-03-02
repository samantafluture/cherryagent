import { createReadStream } from "node:fs";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { GeminiProvider, GroqWhisperClient } from "@cherryagent/core";
import {
  YOUTUBE_NOTES_SYSTEM_PROMPT,
  YOUTUBE_NOTES_RICH_SYSTEM_PROMPT,
} from "@cherryagent/core";
import {
  isYouTubeUrl,
  runYouTubePipeline,
} from "@cherryagent/tools";
import type { YouTubeMode, MediaConfig, ProgressStep } from "@cherryagent/tools";

const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024; // 50MB

const VALID_MODES = new Set<YouTubeMode>(["full", "rich", "audio", "notes"]);

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
}

export function createYouTubeHandlers(deps: YouTubeDeps) {
  const { whisper, gemini, mediaConfig } = deps;

  async function handleYtCommand(ctx: Context) {
    const text = (ctx.match as string | undefined)?.trim();
    if (!text) {
      return ctx.reply(
        "Usage: /yt <url> [mode]\n\n" +
        "Modes:\n" +
        "  full — video + audio + notes (default)\n" +
        "  rich — video + audio + notes (Gemini multimodal)\n" +
        "  audio — audio + notes only\n" +
        "  notes — notes only\n\n" +
        "Batch: send multiple URLs on separate lines",
      );
    }

    // Parse URLs and mode from the input
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const urls: string[] = [];
    let mode: YouTubeMode = "full";

    for (const line of lines) {
      const parts = line.split(/\s+/);
      for (const part of parts) {
        if (isYouTubeUrl(part)) {
          urls.push(part);
        } else if (VALID_MODES.has(part as YouTubeMode)) {
          mode = part as YouTubeMode;
        }
      }
    }

    if (urls.length === 0) {
      return ctx.reply("No valid YouTube URL found. Send a youtube.com or youtu.be link.");
    }

    // Process each URL sequentially
    for (const url of urls) {
      await processOneUrl(ctx, url, mode);
    }
  }

  async function processOneUrl(ctx: Context, url: string, mode: YouTubeMode) {
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
        `Mode: ${mode} | Cost: $${result.costUsd.toFixed(3)}`,
      ].filter(Boolean).join("\n");

      await ctx.api.editMessageText(chatId, progressMsg.message_id, doneText);

      // Deliver video
      if (result.videoPath) {
        await deliverFile(ctx, result.videoPath, result.videoSizeBytes ?? 0, "video");
      }

      // Deliver audio
      if (result.audioPath) {
        await deliverFile(ctx, result.audioPath, result.audioSizeBytes ?? 0, "audio");
      }

      // Deliver notes
      if (result.notes) {
        if (result.notes.length <= 4000) {
          await ctx.reply(result.notes);
        } else {
          // Send as a document
          const notesBuffer = Buffer.from(result.notes, "utf-8");
          const file = new InputFile(notesBuffer, "notes.md");
          await ctx.replyWithDocument(file, {
            caption: `Notes for "${result.metadata.title}"`,
          });
        }
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
  ) {
    if (sizeBytes > TELEGRAM_FILE_LIMIT) {
      await ctx.reply(
        `${type === "video" ? "Video" : "Audio"} file is ${Math.round(sizeBytes / 1024 / 1024)}MB ` +
        `(exceeds Telegram's 50MB limit). File saved at: ${filePath}`,
      );
      return;
    }

    const stream = createReadStream(filePath);
    const file = new InputFile(stream);

    if (type === "video") {
      await ctx.replyWithVideo(file);
    } else {
      await ctx.replyWithAudio(file);
    }
  }

  return { handleYtCommand };
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
