import { YoutubeTranscript } from "youtube-transcript";

/**
 * Extract transcript from a YouTube video using the InnerTube API.
 * No cookies, no downloads, no authentication needed.
 * Returns timestamped text or null if captions are unavailable.
 */
export async function fetchTranscript(videoId: string): Promise<string | null> {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    if (!segments.length) return null;

    const lines: string[] = [];
    for (const seg of segments) {
      const totalSeconds = Math.floor(seg.offset / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const timestamp = `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}]`;
      lines.push(`${timestamp} ${seg.text}`);
    }

    return lines.join("\n");
  } catch {
    return null;
  }
}

/** Extract video ID from a YouTube URL. */
export function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const match = url.match(re);
    if (match) return match[1];
  }
  return null;
}
