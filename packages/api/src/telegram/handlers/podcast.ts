import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { GeminiProvider } from "@cherryagent/core";
import {
  PODCAST_COMPREHENSION_PROMPT,
  PODCAST_COMPREHENSION_TRANSCRIPT_PROMPT,
  YOUTUBE_SOURCE_EXPANSION_PROMPT,
  YOUTUBE_PERSONALIZATION_PROMPT,
} from "@cherryagent/core";
import {
  isPodcastUrl,
  runPodcastPipeline,
  checkSpendWarning,
} from "@cherryagent/tools";
import type { PodcastProgressStep } from "@cherryagent/tools";

const PROGRESS_LABELS: Record<PodcastProgressStep, string> = {
  validating: "Checking podcast...",
  processing_audio: "Processing audio (Gemini)...",
  expanding_sources: "Verifying sources (Google Search)...",
  personalizing: "Connecting to your work...",
  assembling: "Assembling augmented notes...",
  done: "Done!",
};

interface PodcastDeps {
  gemini: GeminiProvider;
  botToken: string;
  costConfig?: {
    timezone?: string;
    dailyCapUsd?: number;
    monthlyCapUsd?: number;
  };
}

export function createPodcastHandlers(deps: PodcastDeps) {
  const { gemini } = deps;

  async function handlePodCommand(ctx: Context) {
    const text = (ctx.match as string | undefined)?.trim();
    if (!text) {
      return ctx.reply(
        "Usage: /pod <url>\n\n" +
          "Produces augmented notes from podcast episodes:\n" +
          "- Deep comprehension (Gemini listens to the audio)\n" +
          "- Verified sources (Google Search)\n" +
          "- Personal connections (brain context)\n\n" +
          "Supported:\n" +
          "  - Spotify episode links\n" +
          "  - RSS feed URLs\n\n" +
          "Best results with RSS feed URLs (direct audio access).\n" +
          "For Spotify, set PODCAST_INDEX_KEY/SECRET for RSS lookup.",
      );
    }

    // Parse URLs from input
    const lines = text
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const urls: string[] = [];

    for (const line of lines) {
      const parts = line.split(/\s+/);
      for (const part of parts) {
        if (isPodcastUrl(part) || part.startsWith("http")) {
          urls.push(part);
        }
      }
    }

    if (urls.length === 0) {
      return ctx.reply(
        "No podcast URL found. Send a Spotify episode link or RSS feed URL.",
      );
    }

    for (const url of urls) {
      await processOneUrl(ctx, url);
    }
  }

  async function processOneUrl(ctx: Context, url: string) {
    const progressMsg = await ctx.reply("Processing podcast...");
    const chatId = ctx.chat!.id;

    const updateProgress = async (
      step: PodcastProgressStep,
      detail?: string,
    ) => {
      const label = PROGRESS_LABELS[step];
      const text = detail ? `${label}\n${detail}` : label;
      try {
        await ctx.api.editMessageText(chatId, progressMsg.message_id, text);
      } catch {
        // Edit may fail if text didn't change
      }
    };

    try {
      const result = await runPodcastPipeline(
        url,
        {
          gemini,
          prompts: {
            comprehension: PODCAST_COMPREHENSION_PROMPT,
            comprehensionTranscript: PODCAST_COMPREHENSION_TRANSCRIPT_PROMPT,
            sourceExpansion: YOUTUBE_SOURCE_EXPANSION_PROMPT,
            personalization: YOUTUBE_PERSONALIZATION_PROMPT,
          },
          costConfig: deps.costConfig,
        },
        updateProgress,
      );

      // Done message
      const passLabel =
        result.passesCompleted === 3
          ? "full augmented"
          : result.passesCompleted === 2
            ? "notes + sources"
            : "notes only";

      const doneText = [
        `Done! "${result.metadata.title}"`,
        `from ${result.metadata.showName}`,
        `Passes: ${result.passesCompleted}/3 (${passLabel}) | Cost: $${result.costUsd.toFixed(3)}`,
      ].join("\n");

      await ctx.api.editMessageText(chatId, progressMsg.message_id, doneText);

      // Check spend warning
      if (result.costUsd > 0) {
        const warning = await checkSpendWarning(deps.costConfig);
        if (warning) await ctx.reply(warning);
      }

      // Deliver markdown
      if (result.markdown.length <= 4000) {
        await ctx.reply(result.markdown);
      } else {
        await ctx.reply(
          result.markdown.slice(0, 4000) +
            "\n\n...(see full notes in file)",
        );
      }

      // Send as .md file
      const notesBuffer = Buffer.from(result.markdown, "utf-8");
      const notesFilename = `${sanitizeFilename(result.metadata.title)} - Podcast Notes.md`;
      const file = new InputFile(notesBuffer, notesFilename);
      await ctx.replyWithDocument(file, {
        caption: `Podcast notes for "${result.metadata.title}"`,
      });

      // Save to brain
      const brainDir = process.env.BRAIN_DIR;
      if (brainDir) {
        try {
          const rawDir = join(brainDir, "library", "raw");
          await mkdir(rawDir, { recursive: true });
          const date = new Date().toISOString().slice(0, 10);
          const slug = sanitizeFilename(result.metadata.title)
            .replace(/\s+/g, "-")
            .toLowerCase();
          const brainFilename = `pod-${slug}-${date}.md`;
          await writeFile(
            join(rawDir, brainFilename),
            result.markdown,
            "utf-8",
          );
          await ctx.reply(`Saved to brain: library/raw/${brainFilename}`);
        } catch {
          // Non-critical
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        chatId,
        progressMsg.message_id,
        `Failed to process podcast:\n${message}`,
      );
    }
  }

  return { handlePodCommand };
}

function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
