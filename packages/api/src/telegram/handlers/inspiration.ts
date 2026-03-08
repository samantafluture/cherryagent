import type { Context } from "grammy";
import { uploadToInspirationBoard } from "@cherryagent/tools";

interface InspirationDeps {
  botToken: string;
  surprideWebhookUrl: string;
  surprideToken: string;
}

export function createInspirationHandlers(deps: InspirationDeps) {
  const { botToken, surprideWebhookUrl, surprideToken } = deps;

  function parseTagsAndNotes(input: string): {
    tags: string[];
    notes?: string;
  } {
    const parts = input.split("|").map((s) => s.trim());
    const tagsPart = parts[0] ?? "";
    const notesPart = parts[1];

    const tags = tagsPart
      ? tagsPart
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    return { tags, notes: notesPart || undefined };
  }

  async function downloadPhoto(
    ctx: Context,
    photoSizes: { file_id: string }[],
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string } | null> {
    const largest = photoSizes[photoSizes.length - 1]!;
    const file = await ctx.api.getFile(largest.file_id);

    if (!file.file_path) return null;

    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Derive mime type from file extension, default to jpeg
    const ext = file.file_path.split(".").pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    };
    const mimeType = mimeMap[ext ?? ""] ?? "image/jpeg";
    const filename = file.file_path.split("/").pop() ?? `photo.${ext ?? "jpg"}`;

    return { buffer, mimeType, filename };
  }

  async function uploadAndReply(
    ctx: Context,
    photo: { buffer: Buffer; mimeType: string; filename: string },
    tags: string[],
    notes?: string,
  ) {
    await ctx.reply("Uploading to inspiration board...");

    const result = await uploadToInspirationBoard({
      webhookUrl: surprideWebhookUrl,
      token: surprideToken,
      imageBuffer: photo.buffer,
      mimeType: photo.mimeType,
      filename: photo.filename,
      tags: tags.length ? tags : undefined,
      notes,
    });

    if (!result.success) {
      return ctx.reply(`Upload failed: ${result.error}`);
    }

    const parts = ["Saved to Inspiration Board!"];
    if (tags.length) parts.push(`Tags: ${tags.join(", ")}`);
    if (notes) parts.push(`Notes: ${notes}`);
    return ctx.reply(parts.join("\n"));
  }

  // /inspo as reply to a photo
  async function handleInspoCommand(ctx: Context) {
    const replyPhoto = ctx.message?.reply_to_message?.photo;
    if (!replyPhoto?.length) {
      return ctx.reply(
        "Usage: Send a photo with /inspo as caption, or reply to a photo with /inspo\n\n" +
          "Examples:\n" +
          "  /inspo\n" +
          "  /inspo nature, colors\n" +
          "  /inspo nature, colors | cool pattern\n" +
          "  /inspo | just some notes",
      );
    }

    const input = ((ctx.match as string | undefined) ?? "").trim();
    const { tags, notes } = input ? parseTagsAndNotes(input) : { tags: [] };

    const photo = await downloadPhoto(ctx, replyPhoto);
    if (!photo) {
      return ctx.reply("Couldn't download the photo. Try again?");
    }

    return uploadAndReply(ctx, photo, tags, notes);
  }

  // Photo sent with /inspo caption
  async function handleInspoPhoto(ctx: Context) {
    const photoSizes = ctx.message?.photo;
    if (!photoSizes?.length) return;

    const caption = (ctx.message?.caption ?? "").trim();
    const afterCommand = caption.replace(/^\/inspo\s*/, "").trim();
    const { tags, notes } = afterCommand
      ? parseTagsAndNotes(afterCommand)
      : { tags: [] as string[] };

    const photo = await downloadPhoto(ctx, photoSizes);
    if (!photo) {
      return ctx.reply("Couldn't download the photo. Try again?");
    }

    return uploadAndReply(ctx, photo, tags, notes);
  }

  return { handleInspoCommand, handleInspoPhoto };
}
