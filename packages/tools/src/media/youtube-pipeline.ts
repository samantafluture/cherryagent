import { unlink } from "node:fs/promises";
import type { YouTubeMode, PipelineResult, ProgressStep, VideoMetadata } from "./types.js";
import type { MediaConfig } from "./config.js";
import { validateYouTubeUrl } from "./validate-url.js";
import { downloadVideo } from "./download.js";
import { extractAudio } from "./extract-audio.js";

// ─── Dependency interfaces (injected by caller to avoid circular deps) ───

interface LLMChatResponse {
  content: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

interface LLMClient {
  chatWithVideo(params: {
    prompt: string;
    videoPath: string;
    systemInstruction?: string;
    maxTokens?: number;
  }): Promise<LLMChatResponse>;
  inputCostPer1M: number;
  outputCostPer1M: number;
}

export interface PipelineDeps {
  llm: LLMClient;
  notesSystemPrompt: string;
}

/** Overall pipeline timeout: 15 minutes max for the entire operation */
const PIPELINE_TIMEOUT_MS = 900_000;

export async function runYouTubePipeline(
  url: string,
  mode: YouTubeMode,
  deps: PipelineDeps,
  config: MediaConfig,
  onProgress?: (step: ProgressStep, detail?: string) => void,
): Promise<PipelineResult> {
  return withTimeout(
    () => runPipelineInner(url, mode, deps, config, onProgress),
    PIPELINE_TIMEOUT_MS,
    "YouTube pipeline timed out — the video may be too long or YouTube is blocking downloads. Try again later.",
  );
}

async function runPipelineInner(
  url: string,
  mode: YouTubeMode,
  deps: PipelineDeps,
  config: MediaConfig,
  onProgress?: (step: ProgressStep, detail?: string) => void,
): Promise<PipelineResult> {
  let totalCost = 0;

  const onRetry = (attempt: number, total: number, reason: string) => {
    onProgress?.("downloading_video", `Retry ${attempt}/${total - 1} (${reason})…`);
  };

  // Step 1: Validate
  onProgress?.("validating");
  const metadata: VideoMetadata = await validateYouTubeUrl(url);

  // Step 2: Download video (all modes now require video for Gemini chatWithVideo)
  onProgress?.("downloading_video", metadata.title);
  const videoResult = await downloadVideo({
    url,
    title: metadata.title,
    mode: "video",
    config,
    onRetry,
  });
  const videoPath = videoResult.filePath;
  const videoSizeBytes = videoResult.fileSizeBytes;

  // Step 3: Extract audio (for modes that deliver audio)
  let audioPath: string | undefined;
  let audioSizeBytes: number | undefined;
  const needsAudio = mode === "full" || mode === "rich" || mode === "audio";

  if (needsAudio) {
    onProgress?.("extracting_audio");
    const destAudioPath = videoPath.replace(/\.mp4$/, ".mp3");
    const audioResult = await extractAudio(videoPath, destAudioPath, config.audioBitrate, config.extractionTimeoutMs);
    audioPath = destAudioPath;
    audioSizeBytes = audioResult.fileSizeBytes;
    metadata.durationSeconds = audioResult.durationSeconds;
  }

  // Step 4: Generate notes via Gemini video input (all modes)
  onProgress?.("generating_notes", "Gemini (video)");
  const response = await deps.llm.chatWithVideo({
    prompt: `Generate detailed reading notes for this video titled "${metadata.title}" by ${metadata.authorName}.`,
    videoPath,
    systemInstruction: deps.notesSystemPrompt,
    maxTokens: 8192,
  });
  const notes = response.content ?? "Failed to generate notes.";
  totalCost += estimateLLMCost(deps.llm, response.usage);

  // Step 5: Cleanup — delete video for modes that don't deliver it
  const deliversVideo = mode === "full" || mode === "rich";
  if (!deliversVideo) {
    try {
      await unlink(videoPath);
    } catch {
      // non-critical
    }
  }

  onProgress?.("done");

  return {
    metadata,
    videoPath: deliversVideo ? videoPath : undefined,
    videoSizeBytes: deliversVideo ? videoSizeBytes : undefined,
    audioPath,
    audioSizeBytes,
    notes,
    costUsd: totalCost,
    mode,
  };
}

function estimateLLMCost(
  llm: { inputCostPer1M: number; outputCostPer1M: number },
  usage: { inputTokens: number; outputTokens: number },
): number {
  return (usage.inputTokens / 1_000_000) * llm.inputCostPer1M +
    (usage.outputTokens / 1_000_000) * llm.outputCostPer1M;
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    fn().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
