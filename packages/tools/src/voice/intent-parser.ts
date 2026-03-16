import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectMapping, VoiceIntent } from "./types.js";

const DEFAULT_REPO_BASE_PATH = "/home/sam/apps";

function getRepoBasePath(): string {
  return process.env.VOICE_REPO_BASE_PATH ?? DEFAULT_REPO_BASE_PATH;
}

function buildDefaultMappings(): ProjectMapping[] {
  const base = getRepoBasePath();
  return [
    {
      slug: "cherrytree",
      keywords: ["cherrytree", "cherry tree", "main site", "portfolio"],
      repoPath: join(base, "cherrytree"),
    },
    {
      slug: "surpride",
      keywords: ["surpride", "wix migration", "wix"],
      repoPath: join(base, "surpride-wix-migration"),
    },
    {
      slug: "fincherry",
      keywords: ["fincherry", "fin cherry", "finance"],
      repoPath: join(base, "fincherry"),
    },
    {
      slug: "saminprogress",
      keywords: ["blog", "saminprogress", "sam in progress"],
      repoPath: join(base, "saminprogress"),
    },
    {
      slug: "cherryagent",
      keywords: ["cherryagent", "cherry agent", "agent", "bot"],
      repoPath: join(base, "cherryagent"),
    },
  ];
}

/** Priority weights for task type detection — lower number = higher priority */
const TASK_TYPE_PRIORITY: Record<VoiceIntent["taskType"], number> = {
  fix: 1,
  test: 2,
  refactor: 3,
  docs: 4,
  investigate: 5,
  feature: 6,
};

const TASK_TYPE_KEYWORDS: Record<VoiceIntent["taskType"], string[]> = {
  fix: ["fix", "bug", "broken", "error", "crash", "wrong", "issue", "lint"],
  feature: ["add", "create", "new", "implement", "build", "feature"],
  refactor: ["refactor", "clean", "reorganize", "restructure", "simplify"],
  test: ["test", "spec", "coverage", "unit test"],
  docs: ["doc", "documentation", "readme", "comment", "jsdoc"],
  investigate: ["investigate", "check", "look", "find", "debug", "why"],
};

/**
 * Parse a transcript into a structured voice intent using keyword matching.
 * Returns null if no project could be identified.
 */
export function parseIntent(
  transcript: string,
  customMappings?: ProjectMapping[],
): VoiceIntent | null {
  const mappings = customMappings ?? buildDefaultMappings();
  const lower = transcript.toLowerCase();

  // Match project
  let matched: ProjectMapping | null = null;
  for (const mapping of mappings) {
    for (const keyword of mapping.keywords) {
      if (lower.includes(keyword)) {
        matched = mapping;
        break;
      }
    }
    if (matched) break;
  }

  if (!matched) return null;

  // Validate repo path exists
  if (!existsSync(matched.repoPath)) {
    console.warn(
      `[voice] Repo path does not exist: ${matched.repoPath}. ` +
        `Set VOICE_REPO_BASE_PATH env var to the correct base directory.`,
    );
    return null;
  }

  // Match task type using priority-based detection
  let taskType: VoiceIntent["taskType"] = "feature";
  let bestPriority = TASK_TYPE_PRIORITY.feature;

  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        const priority = TASK_TYPE_PRIORITY[type as VoiceIntent["taskType"]];
        if (priority < bestPriority) {
          taskType = type as VoiceIntent["taskType"];
          bestPriority = priority;
        }
        break;
      }
    }
  }

  // Generate branch name from transcript
  const branchName = generateBranchName(taskType, transcript);

  // Generate PR title
  const prTitle = generatePrTitle(taskType, transcript);

  return {
    project: matched.slug,
    repoPath: matched.repoPath,
    taskType,
    branchName,
    prTitle,
    taskDescription: transcript,
    transcript,
  };
}

function generateBranchName(
  taskType: string,
  transcript: string,
): string {
  const stopWords = new Set([
    "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
    "is", "it", "and", "or", "but", "that", "this", "can", "you",
    "please", "could", "would", "should", "i", "me", "my", "want",
  ]);

  const words = transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 4);

  const slug = words.join("-") || "voice-task";
  return `voice/${taskType}-${slug}`;
}

function generatePrTitle(
  taskType: string,
  transcript: string,
): string {
  const prefixMap: Record<string, string> = {
    fix: "fix",
    feature: "feat",
    refactor: "refactor",
    test: "test",
    docs: "docs",
    investigate: "chore",
  };

  const prefix = prefixMap[taskType] ?? "feat";

  const desc = transcript.length > 55
    ? transcript.slice(0, 55).replace(/\s+\S*$/, "") + "…"
    : transcript;

  return `${prefix}: ${desc.charAt(0).toLowerCase()}${desc.slice(1)}`;
}

export { buildDefaultMappings as getDefaultProjectMappings };
