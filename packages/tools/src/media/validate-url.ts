import type { VideoMetadata } from "./types.js";

const YOUTUBE_URL_RE =
  /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+/;

export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_URL_RE.test(url);
}

export async function validateYouTubeUrl(url: string): Promise<VideoMetadata> {
  if (!isYouTubeUrl(url)) {
    throw new Error("Not a valid YouTube URL");
  }

  // Use YouTube oEmbed API to get video metadata (no API key needed)
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const response = await fetch(oembedUrl);

  if (!response.ok) {
    throw new Error(`YouTube oEmbed returned ${response.status} — video may be private or unavailable`);
  }

  const data = (await response.json()) as {
    title: string;
    author_name: string;
    thumbnail_url?: string;
  };

  return {
    title: data.title,
    authorName: data.author_name,
    thumbnailUrl: data.thumbnail_url,
  };
}
