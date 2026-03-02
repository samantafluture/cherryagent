import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

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
    if (fileStats.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `Audio file too large (${Math.round(fileStats.size / 1024 / 1024)}MB). ` +
        `Groq Whisper limit is 25MB. Try a shorter video (<30 min).`,
      );
    }

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

  estimateCost(durationSeconds: number): number {
    return (durationSeconds / 3600) * this.costPerHour;
  }
}
