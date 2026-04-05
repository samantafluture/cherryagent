import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read all .md files from the BRAIN_DIR environment variable path.
 * Returns concatenated content, or empty string if not configured / not found.
 */
export async function readBrainContext(): Promise<string> {
  const brainDir = process.env.BRAIN_DIR;
  if (!brainDir) return "";

  let entries: string[];
  try {
    entries = await readdir(brainDir);
  } catch {
    return "";
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
  if (mdFiles.length === 0) return "";

  const sections: string[] = [];
  for (const file of mdFiles) {
    try {
      const content = await readFile(join(brainDir, file), "utf-8");
      if (content.trim()) {
        sections.push(content.trim());
      }
    } catch {
      // skip unreadable files
    }
  }

  return sections.join("\n\n---\n\n");
}
