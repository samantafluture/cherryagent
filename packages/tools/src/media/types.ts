export type YouTubeMode = "full" | "rich" | "audio" | "notes";

export interface VideoMetadata {
  title: string;
  authorName: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}

export interface DownloadResult {
  filePath: string;
  fileSizeBytes: number;
  format: "mp4" | "mp3";
}

export interface AudioExtractionResult {
  filePath: string;
  fileSizeBytes: number;
  durationSeconds: number;
}

export interface PipelineResult {
  metadata: VideoMetadata;
  videoPath?: string;
  videoSizeBytes?: number;
  audioPath?: string;
  audioSizeBytes?: number;
  notes: string;
  costUsd: number;
  mode: YouTubeMode;
}

export type ProgressStep =
  | "validating"
  | "downloading_video"
  | "downloading_audio"
  | "extracting_audio"
  | "transcribing"
  | "generating_notes"
  | "done";

export interface FavoriteItem {
  id: number;
  url: string;
  title: string;
  authorName: string;
  thumbnailUrl?: string;
  savedAt: number;
}
