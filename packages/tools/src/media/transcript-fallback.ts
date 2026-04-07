const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const CLIENT_VERSION = "20.10.38";
const USER_AGENT = `com.google.android.youtube/${CLIENT_VERSION} (Linux; U; Android 14)`;

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
}

/**
 * Extract transcript from a YouTube video using the InnerTube API.
 * No cookies, no downloads, no authentication needed.
 * Returns timestamped text or null if captions are unavailable.
 */
export async function fetchTranscript(videoId: string): Promise<string | null> {
  try {
    // Step 1: Get caption tracks via InnerTube player API
    const playerResponse = await fetch(INNERTUBE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: CLIENT_VERSION,
          },
        },
        videoId,
      }),
    });

    if (!playerResponse.ok) return null;

    const data = await playerResponse.json() as {
      captions?: {
        playerCaptionsTracklistRenderer?: {
          captionTracks?: CaptionTrack[];
        };
      };
    };

    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) return null;

    // Step 2: Fetch the transcript XML from the first available track
    const trackUrl = tracks[0].baseUrl;
    if (!trackUrl) return null;

    const transcriptResponse = await fetch(trackUrl, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!transcriptResponse.ok) return null;

    const xml = await transcriptResponse.text();

    // Step 3: Parse XML into timestamped lines
    return parseTranscriptXml(xml);
  } catch {
    return null;
  }
}

/** Extract video ID from a YouTube URL. */
export function extractVideoId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/,
  );
  return match ? match[1] : null;
}

function parseTranscriptXml(xml: string): string | null {
  // Try new format: <p t="offset_ms" d="duration_ms"><s>text</s></p>
  const newFormatRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  const lines: string[] = [];
  let match: RegExpExecArray | null;

while ((match = newFormatRegex.exec(xml)) !== null) {
    const offsetMs = parseInt(match[1], 10);
    const rawContent = match[3];

    // Extract text from <s> tags or use raw content
    let text = "";
    const segRegex = /<s[^>]*>([^<]*)<\/s>/g;
    let seg: RegExpExecArray | null;
    while ((seg = segRegex.exec(rawContent)) !== null) {
      text += seg[1];
    }
    if (!text) text = rawContent.replace(/<[^>]+>/g, "");
    text = decodeEntities(text).trim();

    if (text) {
      const timestamp = formatTimestamp(offsetMs / 1000);
      lines.push(`${timestamp} ${text}`);
    }
  }

  // Fall back to old format: <text start="seconds" dur="seconds">text</text>
  if (lines.length === 0) {
    const oldFormatRegex = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
    while ((match = oldFormatRegex.exec(xml)) !== null) {
      const offsetSec = parseFloat(match[1]);
      const text = decodeEntities(match[3]).trim();
      if (text) {
        const timestamp = formatTimestamp(offsetSec);
        lines.push(`${timestamp} ${text}`);
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}]`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}
