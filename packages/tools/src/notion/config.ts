import { resolve } from "node:path";

const PROJECTS_BASE = process.env.PROJECTS_BASE ?? "/home/samantafluture/Development";

export interface NotionProjectMapping {
  slug: string;
  repoPath: string;
}

/**
 * Maps Notion "Project" select values to local repo slugs and paths.
 * Only projects with a known repo are included — others are skipped during sync.
 */
const RAW_MAP: Record<string, string> = {
  "CherryAgent": "cherryagent",
  "Voilà Prep": "voila-prep",
  "SpoonLog": "spoonlog",
  "Surpride": "surpride",
  "CherryOps": "cherryops",
  "saminprogress": "saminprogress",
  "samantafluture.com": "samantafluture-site",
  "FinCherry": "fincherry",
  "Recordoc": "recordoc",
  "CherryKit": "cherrykit",
};

export function getProjectMapping(notionProject: string): NotionProjectMapping | undefined {
  const slug = RAW_MAP[notionProject];
  if (!slug) return undefined;
  return {
    slug,
    repoPath: resolve(PROJECTS_BASE, slug),
  };
}

export function getAllProjectMappings(): Map<string, NotionProjectMapping> {
  const map = new Map<string, NotionProjectMapping>();
  for (const [notionName, slug] of Object.entries(RAW_MAP)) {
    map.set(notionName, {
      slug,
      repoPath: resolve(PROJECTS_BASE, slug),
    });
  }
  return map;
}
