import type { ProjectMapping, VoiceIntent } from "./types.js";

const DEFAULT_PROJECT_MAPPINGS: ProjectMapping[] = [
  {
    slug: "cherrytree",
    keywords: ["cherrytree", "cherry tree", "main site", "portfolio"],
    repoPath: "/home/claude-worker/repos/cherrytree",
  },
  {
    slug: "surpride",
    keywords: ["surpride", "wix migration", "wix"],
    repoPath: "/home/claude-worker/repos/surpride-wix-migration",
  },
  {
    slug: "fincherry",
    keywords: ["fincherry", "fin cherry", "finance"],
    repoPath: "/home/claude-worker/repos/fincherry",
  },
  {
    slug: "saminprogress",
    keywords: ["blog", "saminprogress", "sam in progress"],
    repoPath: "/home/claude-worker/repos/saminprogress",
  },
  {
    slug: "cherryagent",
    keywords: ["cherryagent", "cherry agent", "agent", "bot"],
    repoPath: "/home/claude-worker/repos/cherryagent",
  },
];

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
  const mappings = customMappings ?? DEFAULT_PROJECT_MAPPINGS;
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

  // Match task type
  let taskType: VoiceIntent["taskType"] = "feature";
  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        taskType = type as VoiceIntent["taskType"];
        break;
      }
    }
    if (taskType !== "feature") break;
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
  // Extract meaningful words, skip common filler
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

  // Take first ~60 chars of transcript as description
  const desc = transcript.length > 55
    ? transcript.slice(0, 55).replace(/\s+\S*$/, "") + "…"
    : transcript;

  return `${prefix}: ${desc.charAt(0).toLowerCase()}${desc.slice(1)}`;
}

export { DEFAULT_PROJECT_MAPPINGS };
