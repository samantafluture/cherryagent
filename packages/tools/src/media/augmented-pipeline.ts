import type { VideoMetadata } from "./types.js";
import { validateYouTubeUrl } from "./validate-url.js";
import { readBrainContext } from "./brain-context.js";
import { logCost } from "../cost/cost-tracker.js";

// ---------- Types ----------

export interface AugmentedPipelineDeps {
  gemini: {
    chatWithYouTubeUrl(params: {
      prompt: string;
      youtubeUrl: string;
      systemInstruction?: string;
      maxTokens?: number;
    }): Promise<{ content: string | null; usage: { inputTokens: number; outputTokens: number } }>;
    chatWithGrounding(params: {
      prompt: string;
      systemInstruction?: string;
      maxTokens?: number;
    }): Promise<{
      content: string | null;
      usage: { inputTokens: number; outputTokens: number };
      groundingChunks: { title: string; uri: string }[];
    }>;
    chat(params: {
      messages: { role: "user" | "assistant"; content: string }[];
      systemInstruction?: string;
      maxTokens?: number;
    }): Promise<{ content: string | null; usage: { inputTokens: number; outputTokens: number } }>;
    inputCostPer1M: number;
    outputCostPer1M: number;
  };
  transcriptFallback: (videoId: string) => Promise<string | null>;
  prompts: {
    comprehension: string;
    comprehensionTranscript: string;
    sourceExpansion: string;
    personalization: string;
  };
  costConfig?: {
    timezone?: string;
  };
}

export interface AugmentedPipelineResult {
  metadata: VideoMetadata;
  markdown: string;
  passes: {
    comprehension: string | null;
    sourceExpansion: string | null;
    personalization: string | null;
  };
  groundingSources: { title: string; uri: string }[];
  costUsd: number;
  passesCompleted: number;
}

export type AugmentedProgressStep =
  | "validating"
  | "comprehending"
  | "comprehending_fallback"
  | "expanding_sources"
  | "personalizing"
  | "assembling"
  | "done";

// ---------- Pipeline ----------

const PIPELINE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function runAugmentedPipeline(
  url: string,
  deps: AugmentedPipelineDeps,
  onProgress?: (step: AugmentedProgressStep, detail?: string) => void,
): Promise<AugmentedPipelineResult> {
  const deadline = Date.now() + PIPELINE_TIMEOUT_MS;

  function checkTimeout(): void {
    if (Date.now() > deadline) throw new Error("Pipeline timeout (5 minutes)");
  }

  let totalCost = 0;
  const { gemini } = deps;

  function addCost(usage: { inputTokens: number; outputTokens: number }): void {
    totalCost +=
      (usage.inputTokens / 1_000_000) * gemini.inputCostPer1M +
      (usage.outputTokens / 1_000_000) * gemini.outputCostPer1M;
  }

  // --- Pass 0: Metadata ---
  onProgress?.("validating");
  const metadata = await validateYouTubeUrl(url);
  checkTimeout();

  // --- Pass 1: Deep Comprehension ---
  onProgress?.("comprehending");
  let comprehension: string | null = null;
  let usedFallback = false;

  try {
    const result = await gemini.chatWithYouTubeUrl({
      prompt: `Video: "${metadata.title}" by ${metadata.authorName}\nURL: ${url}`,
      youtubeUrl: url,
      systemInstruction: deps.prompts.comprehension,
      maxTokens: 8192,
    });
    comprehension = result.content;
    addCost(result.usage);
  } catch {
    // Fallback: transcript extraction
    onProgress?.("comprehending_fallback");
    const videoId = extractVideoIdFromUrl(url);
    if (videoId) {
      const transcript = await deps.transcriptFallback(videoId);
      if (transcript) {
        usedFallback = true;
        const result = await gemini.chat({
          messages: [
            {
              role: "user",
              content: `Video: "${metadata.title}" by ${metadata.authorName}\nURL: ${url}\n\nTranscript:\n${transcript}`,
            },
          ],
          systemInstruction: deps.prompts.comprehensionTranscript,
          maxTokens: 8192,
        });
        comprehension = result.content;
        addCost(result.usage);
      }
    }
  }

  checkTimeout();

  if (!comprehension) {
    throw new Error(
      "Could not process video — Gemini URL processing and transcript extraction both failed",
    );
  }

  let passesCompleted = 1;

  // --- Pass 2: Source Expansion ---
  onProgress?.("expanding_sources");
  let sourceExpansion: string | null = null;
  let groundingSources: { title: string; uri: string }[] = [];

  const referencesSection = extractReferencesSection(comprehension);

  if (referencesSection && referencesSection !== "No specific external references mentioned.") {
    try {
      const result = await gemini.chatWithGrounding({
        prompt: `Here are the references extracted from a video titled "${metadata.title}":\n\n${referencesSection}\n\nVerify and expand on each reference.`,
        systemInstruction: deps.prompts.sourceExpansion,
        maxTokens: 4096,
      });
      sourceExpansion = result.content;
      groundingSources = result.groundingChunks;
      addCost(result.usage);
      passesCompleted = 2;
    } catch {
      // Graceful: proceed without source expansion
    }
  } else {
    // No references to expand — skip Pass 2 but count it as complete
    passesCompleted = 2;
  }

  checkTimeout();

  // --- Pass 3: Personal Contextualization ---
  onProgress?.("personalizing");
  let personalization: string | null = null;

  try {
    const brainContext = await readBrainContext("deep");

    if (brainContext) {
      const result = await gemini.chat({
        messages: [
          {
            role: "user",
            content: `## Video Notes\n\n${comprehension}\n\n---\n\n## Brain Context\n\n${brainContext}`,
          },
        ],
        systemInstruction: deps.prompts.personalization,
        maxTokens: 4096,
      });
      personalization = result.content;
      addCost(result.usage);
      passesCompleted = 3;
    }
  } catch {
    // Graceful: proceed without personalization
  }

  checkTimeout();

  // --- Assemble ---
  onProgress?.("assembling");
  const markdown = assembleMarkdown(
    url,
    metadata,
    comprehension,
    sourceExpansion,
    personalization,
    groundingSources,
    usedFallback,
  );

  // Log cost
  try {
    await logCost(
      "youtube",
      "gemini",
      totalCost,
      `augmented: ${metadata.title}`,
      deps.costConfig?.timezone,
    );
  } catch {
    // non-critical
  }

  onProgress?.("done");

  return {
    metadata,
    markdown,
    passes: {
      comprehension,
      sourceExpansion,
      personalization,
    },
    groundingSources,
    costUsd: totalCost,
    passesCompleted,
  };
}

// ---------- Helpers ----------

function extractReferencesSection(comprehension: string): string | null {
  const marker = "## References Mentioned";
  const idx = comprehension.indexOf(marker);
  if (idx === -1) return null;

  // Get everything from the marker to the next ## heading or end of string
  const afterMarker = comprehension.slice(idx + marker.length);
  const nextHeading = afterMarker.indexOf("\n## ");
  const content = nextHeading === -1 ? afterMarker : afterMarker.slice(0, nextHeading);
  return content.trim();
}

function extractVideoIdFromUrl(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  );
  return match ? match[1] : null;
}

function assembleMarkdown(
  url: string,
  metadata: VideoMetadata,
  comprehension: string,
  sourceExpansion: string | null,
  personalization: string | null,
  groundingSources: { title: string; uri: string }[],
  usedFallback: boolean,
): string {
  const sections: string[] = [];

  // Header
  sections.push(`# ${metadata.title}`);
  sections.push(`**${metadata.authorName}** | [Watch on YouTube](${url})`);
  if (usedFallback) {
    sections.push(`*Processed via transcript fallback (no visual analysis)*`);
  }
  sections.push("");

  // Pass 1 sections — extract from comprehension output
  const tldr = extractSection(comprehension, "## TL;DR");
  const keyArgs = extractSection(comprehension, "## Key Arguments");
  const visuals = extractSection(comprehension, "## Visual Elements");
  const thesis = extractSection(comprehension, "## Speaker's Core Thesis");

  if (tldr) {
    sections.push("## TL;DR");
    sections.push(tldr);
    sections.push("");
  }

  if (thesis) {
    sections.push("## Speaker's Core Thesis");
    sections.push(thesis);
    sections.push("");
  }

  if (keyArgs) {
    sections.push("## Key Arguments");
    sections.push(keyArgs);
    sections.push("");
  }

  if (visuals && !visuals.includes("Transcript-only analysis")) {
    sections.push("## Visual Elements");
    sections.push(visuals);
    sections.push("");
  }

  // Pass 2: Sources
  if (sourceExpansion) {
    sections.push(sourceExpansion);
    sections.push("");
  } else {
    // Fall back to raw references from Pass 1
    const refs = extractSection(comprehension, "## References Mentioned");
    if (refs && refs !== "No specific external references mentioned.") {
      sections.push("## References Mentioned");
      sections.push(refs);
      sections.push("");
    }
  }

  // Grounding sources (from Google Search)
  if (groundingSources.length > 0) {
    sections.push("### Search Sources Used");
    for (const src of groundingSources) {
      sections.push(`- [${src.title}](${src.uri})`);
    }
    sections.push("");
  }

  // Pass 3: Personalization
  if (personalization) {
    sections.push(personalization);
    sections.push("");
  }

  // Full notes (collapsed)
  sections.push("---");
  sections.push("<details><summary>Full Notes</summary>");
  sections.push("");
  sections.push(comprehension);
  sections.push("");
  sections.push("</details>");

  return sections.join("\n");
}

function extractSection(content: string, heading: string): string | null {
  const idx = content.indexOf(heading);
  if (idx === -1) return null;

  const afterHeading = content.slice(idx + heading.length);
  const nextHeading = afterHeading.indexOf("\n## ");
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  return section.trim();
}
