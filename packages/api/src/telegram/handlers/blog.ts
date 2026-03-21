import type { Context } from "grammy";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { resolve, basename } from "path";
import { listProjects, commitAndPushFiles } from "@cherryagent/tools";

const BLOG_SLUG = "saminprogress";

function getBlogRepoPath(): string | null {
  const projects = listProjects();
  const blog = projects.find((p) => p.slug === BLOG_SLUG);
  return blog?.repoPath ?? null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function createBlogHandlers() {
  async function handleBlogCommand(ctx: Context) {
    const args = ((ctx.match as string) ?? "").trim();

    if (!args) {
      return ctx.reply(
        "<b>✍️ saminprogress Blog</b>\n\n" +
          "<b>Ideas:</b>\n" +
          "  /blog ideas — view saved ideas\n" +
          '  /blog idea "text" — save a new idea\n\n' +
          "<b>Drafts:</b>\n" +
          "  /blog drafts — list current drafts\n" +
          "  /blog status &lt;slug&gt; — check draft status\n",
        { parse_mode: "HTML" },
      );
    }

    const parts = args.split(/\s+/);
    const action = parts[0]?.toLowerCase();

    switch (action) {
      case "ideas":
        return handleIdeas(ctx);
      case "idea":
        return handleNewIdea(ctx, args);
      case "drafts":
        return handleDrafts(ctx);
      case "status":
        return handleStatus(ctx, parts[1]);
      default:
        return ctx.reply(
          `Unknown action: ${action}\nActions: ideas, idea, drafts, status`,
        );
    }
  }

  async function handleIdeas(ctx: Context) {
    const repoPath = getBlogRepoPath();
    if (!repoPath) {
      return ctx.reply("saminprogress repo not found.");
    }

    const ideasPath = resolve(repoPath, "src/drafts/ideas.md");
    if (!existsSync(ideasPath)) {
      return ctx.reply("No ideas file found. Save one with /blog idea \"your idea\"");
    }

    const content = readFileSync(ideasPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.startsWith("- "));

    if (lines.length === 0) {
      return ctx.reply(
        "✍️ No saved ideas yet.\n\nSave one with /blog idea \"your idea\"",
      );
    }

    const formatted = lines
      .map((line) => `  ${escapeHtml(line)}`)
      .join("\n");

    return ctx.reply(
      `<b>✍️ Blog Ideas</b> (${lines.length})\n\n${formatted}`,
      { parse_mode: "HTML" },
    );
  }

  async function handleNewIdea(ctx: Context, args: string) {
    const match = args.match(/"([^"]+)"/);
    if (!match) {
      return ctx.reply('Usage: /blog idea "Your idea here"');
    }

    const repoPath = getBlogRepoPath();
    if (!repoPath) {
      return ctx.reply("saminprogress repo not found.");
    }

    const idea = match[1];
    const today = new Date().toISOString().split("T")[0];
    const ideasPath = resolve(repoPath, "src/drafts/ideas.md");

    let content = "# Blog Ideas\n\n";
    if (existsSync(ideasPath)) {
      content = readFileSync(ideasPath, "utf-8");
    }

    // Append the new idea
    const newLine = `- ${today}: ${idea}\n`;
    content = content.trimEnd() + "\n" + newLine;

    writeFileSync(ideasPath, content, "utf-8");

    // Git sync
    try {
      await commitAndPushFiles(repoPath, ["src/drafts/ideas.md"], "chore: add blog idea");
    } catch (err) {
      console.error("[blog] Git sync failed:", err);
    }

    return ctx.reply(`💡 Saved: ${escapeHtml(idea)}`, { parse_mode: "HTML" });
  }

  async function handleDrafts(ctx: Context) {
    const repoPath = getBlogRepoPath();
    if (!repoPath) {
      return ctx.reply("saminprogress repo not found.");
    }

    const draftsDir = resolve(repoPath, "src/drafts");
    if (!existsSync(draftsDir)) {
      return ctx.reply("No drafts directory found.");
    }

    const files = readdirSync(draftsDir)
      .filter((f) => f.endsWith(".md") && f !== "ideas.md");

    if (files.length === 0) {
      return ctx.reply("✍️ No drafts in progress.\n\nStart one in Claude Code with /writer");
    }

    const lines = ["<b>✍️ Drafts</b>", ""];

    for (const file of files) {
      const filePath = resolve(draftsDir, file);
      const content = readFileSync(filePath, "utf-8");
      const slug = basename(file, ".md");
      const status = extractFrontmatter(content, "status") ?? "unknown";
      const title = extractFrontmatter(content, "title") ?? slug;
      const statusIcon = status === "edited" ? "✅" : status === "draft" ? "📝" : "❓";
      lines.push(`${statusIcon} <b>${escapeHtml(title)}</b>`);
      lines.push(`   <code>${slug}</code> — ${status}`);
      lines.push("");
    }

    return ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }

  async function handleStatus(ctx: Context, slug?: string) {
    if (!slug) {
      return ctx.reply("Usage: /blog status &lt;slug&gt;", { parse_mode: "HTML" });
    }

    const repoPath = getBlogRepoPath();
    if (!repoPath) {
      return ctx.reply("saminprogress repo not found.");
    }

    // Check drafts first, then published
    const draftPath = resolve(repoPath, `src/drafts/${slug}.md`);
    const publishedPath = resolve(repoPath, `src/content/blog/${slug}.md`);

    if (existsSync(draftPath)) {
      const content = readFileSync(draftPath, "utf-8");
      const title = extractFrontmatter(content, "title") ?? slug;
      const status = extractFrontmatter(content, "status") ?? "draft";
      const date = extractFrontmatter(content, "date") ?? "unknown";
      return ctx.reply(
        `<b>✍️ ${escapeHtml(title)}</b>\n\n` +
          `Status: ${status}\n` +
          `Date: ${date}\n` +
          `Location: <code>src/drafts/${slug}.md</code>`,
        { parse_mode: "HTML" },
      );
    }

    if (existsSync(publishedPath)) {
      const content = readFileSync(publishedPath, "utf-8");
      const title = extractFrontmatter(content, "title") ?? slug;
      const date = extractFrontmatter(content, "date") ?? "unknown";
      return ctx.reply(
        `<b>✍️ ${escapeHtml(title)}</b>\n\n` +
          `Status: published ✅\n` +
          `Date: ${date}\n` +
          `Location: <code>src/content/blog/${slug}.md</code>`,
        { parse_mode: "HTML" },
      );
    }

    return ctx.reply(`No draft or post found with slug: ${slug}`);
  }

  return { handleBlogCommand };
}

/** Extract a frontmatter value by key from markdown content */
function extractFrontmatter(content: string, key: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const line = fmMatch[1]
    .split("\n")
    .find((l) => l.startsWith(`${key}:`));
  if (!line) return null;

  let value = line.slice(key.length + 1).trim();
  // Strip surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}
