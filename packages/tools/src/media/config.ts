import { join } from "node:path";

export interface MediaConfig {
  mediaDir: string;
  videoRetentionHours: number;
  audioRetentionHours: number;
  notesRetentionDays: number;
  videoMaxHeight: number;
  audioBitrate: string;
}

export function getMediaConfig(): MediaConfig {
  const home = process.env["HOME"] ?? ".";
  return {
    mediaDir: process.env["MEDIA_DIR"] ?? join(home, ".cherryagent", "media"),
    videoRetentionHours: parseInt(process.env["VIDEO_RETENTION_HOURS"] ?? "24", 10),
    audioRetentionHours: parseInt(process.env["AUDIO_RETENTION_HOURS"] ?? "48", 10),
    notesRetentionDays: parseInt(process.env["NOTES_RETENTION_DAYS"] ?? "30", 10),
    videoMaxHeight: parseInt(process.env["VIDEO_MAX_HEIGHT"] ?? "480", 10),
    audioBitrate: process.env["AUDIO_BITRATE"] ?? "128k",
  };
}
