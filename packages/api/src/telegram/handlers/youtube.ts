import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { GeminiProvider } from "@cherryagent/core";
import {
  YOUTUBE_COMPREHENSION_PROMPT,
  YOUTUBE_COMPREHENSION_TRANSCRIPT_PROMPT,
  YOUTUBE_SOURCE_EXPANSION_PROMPT,
  YOUTUBE_PERSONALIZATION_PROMPT,
} from "@cherryagent/core";
import {
  isYouTubeUrl,
  validateYouTubeUrl,
  runAugmentedPipeline,
  addFavorite,
  listFavorites,
  getFavoriteByIndex,
  removeFavoriteByIndex,
  checkSpendWarning,
  fetchTranscript,
} from "@cherryagent/tools";
import type { AugmentedProgressStep } from "@cherryagent/tools";

const SUBCOMMANDS = new Set(["save", "list", "pick", "rm"]);

const PROGRESS_LABELS: Record<AugmentedProgressStep, string> = {
  validating: "Checking video...",
  comprehending: "Watching video (Gemini)...",
  comprehending_fallback: "Reading transcript...",
  expanding_sources: "Verifying sources (Google Search)...",
  personalizing: "Connecting to your work...",
  assembling: "Assembling augmented notes...",
  done: "Done!",
};

interface YouTubeDeps {
  gemini: GeminiProvider;
  botToken: string;
  costConfig?: { timezone?: string; dailyCapUsd?: number; monthlyCapUsd?: number };
}

export function createYouTubeHandlers(deps: YouTubeDeps) {
  const { gemini } = deps;

  async function handleYtCommand(ctx: Context) {
    const text = (ctx.match as string | undefined)?.trim();
    if (!text) {
      return ctx.reply(
        "Usage: /yt <url>\n\n" +
        "Produces augmented notes with:\n" +
        "- Deep comprehension (Gemini watches the video)\n" +
        "- Verified sources (Google Search)\n" +
        "- Personal connections (brain context)\n\n" +
        "Favorites:\n" +
        "  /yt save <url> — save for later\n" +
        "  /yt list — show saved videos\n" +
        "  /yt pick <#> — process a saved video\n" +
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

    // Parse URLs from input
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const urls: string[] = [];

    for (const line of lines) {
      const parts = line.split(/\s+/);
      for (const part of parts) {
        if (isYouTubeUrl(part)) {
          urls.push(part);
        }
      }
    }

    if (urls.length === 0) {
      return ctx.reply("No valid YouTube URL found. Send a youtube.com or youtu.be link.");
    }

    for (const url of urls) {
      await processOneUrl(ctx, url);
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
      return ctx.reply("Usage: /yt pick <#>");
    }

    const item = await getFavoriteByIndex(index);
    if (!item) {
      return ctx.reply(`No saved video at #${index}. Use /yt list to see your list.`);
    }

    await processOneUrl(ctx, item.url);
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

  async function processOneUrl(ctx: Context, url: string) {
    const progressMsg = await ctx.reply("Processing YouTube URL...");
    const chatId = ctx.chat!.id;

    const updateProgress = async (step: AugmentedProgressStep, detail?: string) => {
      const label = PROGRESS_LABELS[step];
      const text = detail ? `${label}\n${detail}` : label;
      try {
        await ctx.api.editMessageText(chatId, progressMsg.message_id, text);
      } catch {
        // Edit may fail if text didn't change
      }
    };

    try {
      const result = await runAugmentedPipeline(
        url,
        {
          gemini,
          transcriptFallback: fetchTranscript,
          prompts: {
            comprehension: YOUTUBE_COMPREHENSION_PROMPT,
            comprehensionTranscript: YOUTUBE_COMPREHENSION_TRANSCRIPT_PROMPT,
            sourceExpansion: YOUTUBE_SOURCE_EXPANSION_PROMPT,
            personalization: YOUTUBE_PERSONALIZATION_PROMPT,
          },
          costConfig: deps.costConfig,
        },
        updateProgress,
      );

      // Update progress to done
      const passLabel =
        result.passesCompleted === 3 ? "full augmented"
        : result.passesCompleted === 2 ? "notes + sources"
        : "notes only";

      const doneText = [
        `Done! "${result.metadata.title}"`,
        `by ${result.metadata.authorName}`,
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
        await ctx.reply(result.markdown.slice(0, 4000) + "\n\n...(see full notes in file)");
      }

      // Always send as .md file
      const notesBuffer = Buffer.from(result.markdown, "utf-8");
      const notesFilename = `${sanitizeFilename(result.metadata.title)} - Augmented Notes.md`;
      const file = new InputFile(notesBuffer, notesFilename);
      await ctx.replyWithDocument(file, {
        caption: `Augmented notes for "${result.metadata.title}"`,
      });

      // Save to brain if BRAIN_DIR is configured
      const brainDir = process.env.BRAIN_DIR;
      if (brainDir) {
        try {
          const rawDir = join(brainDir, "library", "raw");
          await mkdir(rawDir, { recursive: true });
          const date = new Date().toISOString().slice(0, 10);
          const slug = sanitizeFilename(result.metadata.title).replace(/\s+/g, "-").toLowerCase();
          const brainFilename = `yt-${slug}-${date}.md`;
          await writeFile(join(rawDir, brainFilename), result.markdown, "utf-8");
          await ctx.reply(`Saved to brain: library/raw/${brainFilename}`);
        } catch {
          // Non-critical — don't fail the pipeline
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

  return { handleYtCommand };
}

function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
