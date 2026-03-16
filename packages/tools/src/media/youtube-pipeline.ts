import { unlink } from "node:fs/promises";
import type { YouTubeMode, PipelineResult, ProgressStep, VideoMetadata } from "./types.js";
import type { MediaConfig } from "./config.js";
import { validateYouTubeUrl } from "./validate-url.js";
import { downloadVideo } from "./download.js";
import { extractAudio } from "./extract-audio.js";

// ─── Dependency interfaces (injected by caller to avoid circular deps) ───

interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
  durationSeconds: number;
}

interface WhisperClient {
  transcribe(audioPath: string, language?: string): Promise<TranscriptionResult>;
  estimateCost(durationSeconds: number): number;
}

interface LLMChatResponse {
  content: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

interface LLMClient {
  chat(params: {
    systemInstruction?: string;
    messages: { role: "user" | "system" | "assistant" | "tool"; content: string }[];
    maxTokens?: number;
  }): Promise<LLMChatResponse>;
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
  whisper: WhisperClient;
  llm: LLMClient;
  notesSystemPrompt: string;
  richNotesSystemPrompt: string;
}

/** Overall pipeline timeout: 10 minutes max for the entire operation */
const PIPELINE_TIMEOUT_MS = 600_000;

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
    onProgress?.("downloading_audio", `Retry ${attempt}/${total - 1} (${reason})…`);
  };

  // Step 1: Validate
  onProgress?.("validating");
  const metadata: VideoMetadata = await validateYouTubeUrl(url);

  // Step 2: Download
  let videoPath: string | undefined;
  let videoSizeBytes: number | undefined;
  let audioPath: string | undefined;
  let audioSizeBytes: number | undefined;

  const needsVideo = mode === "full" || mode === "rich";

  if (needsVideo) {
    onProgress?.("downloading_video", metadata.title);
    const videoResult = await downloadVideo({
      url,
      title: metadata.title,
      mode: "video",
      config,
      onRetry,
    });
    videoPath = videoResult.filePath;
    videoSizeBytes = videoResult.fileSizeBytes;

    // Extract audio from video
    onProgress?.("extracting_audio");
    audioPath = videoPath.replace(/\.mp4$/, ".mp3");
    const audioResult = await extractAudio(videoPath, audioPath, config.audioBitrate, config.extractionTimeoutMs);
    audioSizeBytes = audioResult.fileSizeBytes;
    metadata.durationSeconds = audioResult.durationSeconds;
  } else {
    // Audio-only download
    onProgress?.("downloading_audio", metadata.title);
    const audioResult = await downloadVideo({
      url,
      title: metadata.title,
      mode: "audio",
      config,
      onRetry,
    });
    audioPath = audioResult.filePath;
    audioSizeBytes = audioResult.fileSizeBytes;
  }

  // Step 3: Generate notes
  let notes: string;

  if (mode === "rich") {
    // Path B: Gemini multimodal video input
    onProgress?.("generating_notes", "Gemini (rich mode)");
    const response = await deps.llm.chatWithVideo({
      prompt: `Generate detailed reading notes for this video titled "${metadata.title}" by ${metadata.authorName}.`,
      videoPath: videoPath!,
      systemInstruction: deps.richNotesSystemPrompt,
      maxTokens: 8192,
    });
    notes = response.content ?? "Failed to generate notes.";
    totalCost += estimateLLMCost(deps.llm, response.usage);
  } else {
    // Path A: Whisper transcription → Gemini notes
    onProgress?.("transcribing", "Groq Whisper");
    const transcription = await deps.whisper.transcribe(audioPath!);
    totalCost += deps.whisper.estimateCost(transcription.durationSeconds);
    metadata.durationSeconds = transcription.durationSeconds;

    // Build timestamped transcript for the notes prompt
    const transcript = transcription.segments
      .map((s) => {
        const mins = Math.floor(s.start / 60);
        const secs = Math.floor(s.start % 60);
        const ts = `${mins}:${secs.toString().padStart(2, "0")}`;
        return `[${ts}] ${s.text}`;
      })
      .join("\n");

    onProgress?.("generating_notes", "Gemini");
    const response = await deps.llm.chat({
      systemInstruction: deps.notesSystemPrompt,
      messages: [
        {
          role: "user",
          content: `Video title: "${metadata.title}" by ${metadata.authorName}\n\nTimestamped transcript:\n${transcript}`,
        },
      ],
      maxTokens: 4096,
    });
    notes = response.content ?? "Failed to generate notes.";
    totalCost += estimateLLMCost(deps.llm, response.usage);
  }

  // Step 4: Cleanup for notes-only mode (delete audio after transcription)
  if (mode === "notes" && audioPath) {
    try {
      await unlink(audioPath);
    } catch {
      // non-critical
    }
    audioPath = undefined;
    audioSizeBytes = undefined;
  }

  onProgress?.("done");

  return {
    metadata,
    videoPath,
    videoSizeBytes,
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
