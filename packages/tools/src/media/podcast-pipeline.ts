import type { PodcastMetadata } from "./types.js";
import { validatePodcastUrl } from "./validate-podcast.js";
import { readBrainContext } from "./brain-context.js";
import { logCost } from "../cost/cost-tracker.js";

// ---------- Types ----------

export interface PodcastPipelineDeps {
  gemini: {
    chatWithAudioUrl(params: {
      prompt: string;
      audioUrl: string;
      systemInstruction?: string;
      maxTokens?: number;
    }): Promise<{
      content: string | null;
      usage: { inputTokens: number; outputTokens: number };
    }>;
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
    }): Promise<{
      content: string | null;
      usage: { inputTokens: number; outputTokens: number };
    }>;
    inputCostPer1M: number;
    outputCostPer1M: number;
  };
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

export interface PodcastPipelineResult {
  metadata: PodcastMetadata;
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

export type PodcastProgressStep =
  | "validating"
  | "processing_audio"
  | "expanding_sources"
  | "personalizing"
  | "assembling"
  | "done";

// ---------- Pipeline ----------

const PIPELINE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (audio upload can be slow)

export async function runPodcastPipeline(
  url: string,
  deps: PodcastPipelineDeps,
  onProgress?: (step: PodcastProgressStep, detail?: string) => void,
): Promise<PodcastPipelineResult> {
  const deadline = Date.now() + PIPELINE_TIMEOUT_MS;

  function checkTimeout(): void {
    if (Date.now() > deadline)
      throw new Error("Pipeline timeout (10 minutes)");
  }

  let totalCost = 0;
  const { gemini } = deps;

  function addCost(usage: {
    inputTokens: number;
    outputTokens: number;
  }): void {
    totalCost +=
      (usage.inputTokens / 1_000_000) * gemini.inputCostPer1M +
      (usage.outputTokens / 1_000_000) * gemini.outputCostPer1M;
  }

  // --- Pass 0: Metadata ---
  onProgress?.("validating");
  const metadata = await validatePodcastUrl(url);
  checkTimeout();

  if (!metadata.audioUrl) {
    throw new Error(
      "Could not find audio URL for this podcast. Try providing the RSS feed URL directly.",
    );
  }

  // --- Pass 1: Audio Comprehension via Gemini ---
  onProgress?.("processing_audio", "Uploading audio to Gemini...");
  let comprehension: string | null = null;

  try {
    const result = await gemini.chatWithAudioUrl({
      prompt: `Podcast episode: "${metadata.title}" from ${metadata.showName}${metadata.authorName ? ` by ${metadata.authorName}` : ""}`,
      audioUrl: metadata.audioUrl,
      systemInstruction: deps.prompts.comprehension,
      maxTokens: 8192,
    });
    comprehension = result.content;
    addCost(result.usage);
  } catch (err) {
    // If audio processing fails, throw with helpful message
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Gemini could not process the audio: ${msg}. The audio URL may be inaccessible or too large.`,
    );
  }

  checkTimeout();

  if (!comprehension) {
    throw new Error(
      "Gemini returned empty content for the podcast audio.",
    );
  }

  let passesCompleted = 1;

  // --- Pass 2: Source Expansion ---
  onProgress?.("expanding_sources");
  let sourceExpansion: string | null = null;
  let groundingSources: { title: string; uri: string }[] = [];

  const referencesSection = extractReferencesSection(comprehension);

  if (
    referencesSection &&
    referencesSection !== "No specific external references mentioned."
  ) {
    try {
      const result = await gemini.chatWithGrounding({
        prompt: `Here are the references extracted from a podcast episode titled "${metadata.title}" from ${metadata.showName}:\n\n${referencesSection}\n\nVerify and expand on each reference.`,
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
            content: `## Podcast Notes\n\n${comprehension}\n\n---\n\n## Brain Context\n\n${brainContext}`,
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
  );

  // Log cost
  try {
    await logCost(
      "podcast",
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

function extractReferencesSection(
  comprehension: string,
): string | null {
  const marker = "## References Mentioned";
  const idx = comprehension.indexOf(marker);
  if (idx === -1) return null;

  const afterMarker = comprehension.slice(idx + marker.length);
  const nextHeading = afterMarker.indexOf("\n## ");
  const content =
    nextHeading === -1 ? afterMarker : afterMarker.slice(0, nextHeading);
  return content.trim();
}

function assembleMarkdown(
  url: string,
  metadata: PodcastMetadata,
  comprehension: string,
  sourceExpansion: string | null,
  personalization: string | null,
  groundingSources: { title: string; uri: string }[],
): string {
  const sections: string[] = [];

  // Header
  sections.push(`# ${metadata.title}`);
  const byline = [
    `**${metadata.showName}**`,
    metadata.authorName ? `by ${metadata.authorName}` : null,
    metadata.episodeUrl ? `| [Listen](${url})` : null,
  ]
    .filter(Boolean)
    .join(" ");
  sections.push(byline);
  sections.push("");

  // Pass 1 sections
  const tldr = extractSection(comprehension, "## TL;DR");
  const keyArgs = extractSection(comprehension, "## Key Arguments");
  const quotes = extractSection(comprehension, "## Notable Quotes");
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

  if (quotes) {
    sections.push("## Notable Quotes");
    sections.push(quotes);
    sections.push("");
  }

  // Pass 2: Sources
  if (sourceExpansion) {
    sections.push(sourceExpansion);
    sections.push("");
  } else {
    const refs = extractSection(comprehension, "## References Mentioned");
    if (refs && refs !== "No specific external references mentioned.") {
      sections.push("## References Mentioned");
      sections.push(refs);
      sections.push("");
    }
  }

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

function extractSection(
  content: string,
  heading: string,
): string | null {
  const idx = content.indexOf(heading);
  if (idx === -1) return null;

  const afterHeading = content.slice(idx + heading.length);
  const nextHeading = afterHeading.indexOf("\n## ");
  const section =
    nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  return section.trim();
}
