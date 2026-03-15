import { readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
  durationSeconds: number;
}

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB Groq limit
const CHUNK_TARGET_BYTES = 24 * 1024 * 1024;  // 24MB target per chunk (safe margin)

export class GroqWhisperClient {
  private apiKey: string;
  private baseUrl: string;

  // Cost: $0.04 per audio hour
  readonly costPerHour = 0.04;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.groq.com/openai/v1";
  }

  async transcribe(audioPath: string, language = "en"): Promise<TranscriptionResult> {
    const fileStats = await stat(audioPath);

    if (fileStats.size <= MAX_FILE_SIZE_BYTES) {
      return this.transcribeSingle(audioPath, language);
    }

    // File too large — split into chunks and transcribe each
    return this.transcribeChunked(audioPath, fileStats.size, language);
  }

  private async transcribeSingle(audioPath: string, language: string): Promise<TranscriptionResult> {
    const formData = new FormData();
    const fileBuffer = await readFile(audioPath);
    const fileBlob = new Blob([fileBuffer.buffer as ArrayBuffer], { type: "audio/mpeg" });
    formData.append("file", fileBlob, basename(audioPath));
    formData.append("model", "whisper-large-v3-turbo");
    formData.append("language", language);
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "segment");

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq Whisper API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      text: string;
      duration: number;
      segments?: { start: number; end: number; text: string }[];
    };

    return {
      text: data.text,
      segments: (data.segments ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text.trim(),
      })),
      durationSeconds: data.duration,
    };
  }

  private async transcribeChunked(
    audioPath: string,
    fileSize: number,
    language: string,
  ): Promise<TranscriptionResult> {
    // Get total duration with ffprobe
    const { stdout: durationStr } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    const totalDuration = parseFloat(durationStr.trim()) || 0;
    if (totalDuration === 0) {
      throw new Error("Could not determine audio duration for chunked transcription.");
    }

    // Calculate chunk duration based on file size ratio
    const numChunks = Math.ceil(fileSize / CHUNK_TARGET_BYTES);
    const chunkDuration = Math.ceil(totalDuration / numChunks);

    // Split into chunks using ffmpeg
    const dir = dirname(audioPath);
    const base = basename(audioPath, ".mp3");
    const chunkPaths: string[] = [];

    for (let i = 0; i < numChunks; i++) {
      const startSec = i * chunkDuration;
      const chunkPath = join(dir, `${base}_chunk${i}.mp3`);
      chunkPaths.push(chunkPath);

      await execFileAsync("ffmpeg", [
        "-i", audioPath,
        "-ss", String(startSec),
        "-t", String(chunkDuration),
        "-vn",
        "-ab", "128k",
        "-ar", "44100",
        "-y",
        chunkPath,
      ], { timeout: 120_000 });
    }

    // Transcribe each chunk and merge results
    const allSegments: TranscriptionSegment[] = [];
    const textParts: string[] = [];
    let totalTranscribedDuration = 0;

    try {
      for (let i = 0; i < chunkPaths.length; i++) {
        const offsetSec = i * chunkDuration;
        const result = await this.transcribeSingle(chunkPaths[i]!, language);

        textParts.push(result.text);
        totalTranscribedDuration += result.durationSeconds;

        // Offset segment timestamps by chunk start time
        for (const seg of result.segments) {
          allSegments.push({
            start: seg.start + offsetSec,
            end: seg.end + offsetSec,
            text: seg.text,
          });
        }
      }
    } finally {
      // Clean up chunk files
      for (const chunkPath of chunkPaths) {
        try { await unlink(chunkPath); } catch { /* ignore */ }
      }
    }

    return {
      text: textParts.join(" "),
      segments: allSegments,
      durationSeconds: totalTranscribedDuration,
    };
  }

  estimateCost(durationSeconds: number): number {
    return (durationSeconds / 3600) * this.costPerHour;
  }
}
