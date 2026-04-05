import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read brain context files from the BRAIN_DIR environment variable path.
 *
 * @param depth - "shallow" reads only top-level .md files (identity, principles,
 *   energy, current-state). "deep" reads recursively including goals/, decisions/,
 *   and library/wiki/ overviews.
 * @returns Concatenated markdown content, or empty string if not configured.
 */
export async function readBrainContext(
  depth: "shallow" | "deep" = "shallow",
): Promise<string> {
  const brainDir = process.env.BRAIN_DIR;
  if (!brainDir) return "";

  const sections: string[] = [];

  // Always read top-level .md files
  try {
    const entries = await readdir(brainDir);
    const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
    for (const file of mdFiles) {
      try {
        const content = await readFile(join(brainDir, file), "utf-8");
        if (content.trim()) sections.push(content.trim());
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    return "";
  }

  if (depth === "deep") {
    // Read goals
    await readDirMd(join(brainDir, "goals"), sections);
    // Read decision index only (not individual decisions)
    try {
      const indexContent = await readFile(
        join(brainDir, "decisions", "_index.md"),
        "utf-8",
      );
      if (indexContent.trim()) sections.push(indexContent.trim());
    } catch {
      // skip
    }
    // Read wiki overviews
    try {
      const wikiDir = join(brainDir, "library", "wiki");
      const topics = await readdir(wikiDir, { withFileTypes: true });
      for (const topic of topics) {
        if (!topic.isDirectory()) continue;
        try {
          const overview = await readFile(
            join(wikiDir, topic.name, "_overview.md"),
            "utf-8",
          );
          if (overview.trim()) sections.push(overview.trim());
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }

  return sections.join("\n\n---\n\n");
}

async function readDirMd(dir: string, sections: string[]): Promise<void> {
  try {
    const entries = await readdir(dir);
    const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
    for (const file of mdFiles) {
      try {
        const content = await readFile(join(dir, file), "utf-8");
        if (content.trim()) sections.push(content.trim());
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
}
