import type { PodcastMetadata } from "./types.js";

const SPOTIFY_EPISODE_RE =
  /^https?:\/\/open\.spotify\.com\/episode\/([a-zA-Z0-9]+)/;
const SPOTIFY_SHOW_RE =
  /^https?:\/\/open\.spotify\.com\/show\/([a-zA-Z0-9]+)/;
const RSS_INDICATORS = [".xml", "/rss", "/feed", "format=xml", "type=rss"];

export function isPodcastUrl(url: string): boolean {
  return (
    SPOTIFY_EPISODE_RE.test(url) ||
    SPOTIFY_SHOW_RE.test(url) ||
    RSS_INDICATORS.some((ind) => url.toLowerCase().includes(ind))
  );
}

export async function validatePodcastUrl(
  url: string,
): Promise<PodcastMetadata> {
  // Spotify episode URL
  const spotifyMatch = url.match(SPOTIFY_EPISODE_RE);
  if (spotifyMatch) {
    return resolveSpotifyEpisode(url);
  }

  // RSS feed URL
  if (RSS_INDICATORS.some((ind) => url.toLowerCase().includes(ind))) {
    return resolveRssEpisode(url);
  }

  // Try treating it as a direct RSS feed anyway
  try {
    return await resolveRssEpisode(url);
  } catch {
    throw new Error(
      "Not a recognized podcast URL. Supported: Spotify episode links, RSS feed URLs.",
    );
  }
}

async function resolveSpotifyEpisode(url: string): Promise<PodcastMetadata> {
  // Use Spotify oEmbed for metadata (no auth needed)
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const resp = await fetch(oembedUrl, {
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error(
      `Spotify oEmbed returned ${resp.status}. Episode may be private or unavailable.`,
    );
  }

  const data = (await resp.json()) as {
    title: string;
    description?: string;
    provider_name?: string;
  };

  // Try to find audio URL via Podcast Index API
  const audioUrl = await findAudioViaPodcastIndex(
    data.provider_name ?? "",
    data.title,
  );

  return {
    title: data.title,
    showName: data.provider_name ?? "Unknown Show",
    episodeUrl: url,
    description: data.description,
    audioUrl: audioUrl ?? undefined,
  };
}

async function resolveRssEpisode(
  feedUrl: string,
  targetTitle?: string,
): Promise<PodcastMetadata> {
  const resp = await fetch(feedUrl, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "CherryAgent-Pod/1.0" },
  });

  if (!resp.ok) {
    throw new Error(`RSS feed returned ${resp.status}`);
  }

  const xml = await resp.text();

  // Extract show name from <channel><title>
  const showMatch = xml.match(
    /<channel>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/,
  );
  const showName = showMatch?.[1]?.trim() ?? "Unknown Show";

  // Find most recent <item> or one matching targetTitle
  const items = xml.split(/<item[\s>]/);
  if (items.length < 2) {
    throw new Error("No episodes found in RSS feed");
  }

  // Take the first item (most recent) or match by title
  let targetItem = items[1];
  if (targetTitle) {
    const match = items.find((item) =>
      item.toLowerCase().includes(targetTitle.toLowerCase()),
    );
    if (match) targetItem = match;
  }

  // Extract episode title
  const titleMatch = targetItem.match(
    /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/,
  );
  const title = titleMatch?.[1]?.trim() ?? "Unknown Episode";

  // Extract audio URL from <enclosure>
  const enclosureMatch = targetItem.match(
    /<enclosure[^>]+url=["']([^"']+)["']/,
  );
  const audioUrl = enclosureMatch?.[1] ?? null;

  // Extract author
  const authorMatch = targetItem.match(
    /<(?:itunes:author|author)>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/(?:itunes:author|author)>/,
  );
  const authorName = authorMatch?.[1]?.trim();

  // Extract description
  const descMatch = targetItem.match(
    /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/,
  );
  const description = descMatch?.[1]
    ?.replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, 500);

  return {
    title,
    showName,
    authorName,
    audioUrl: audioUrl ?? undefined,
    description,
  };
}

async function findAudioViaPodcastIndex(
  showName: string,
  episodeTitle: string,
): Promise<string | null> {
  const apiKey = process.env.PODCAST_INDEX_KEY;
  const apiSecret = process.env.PODCAST_INDEX_SECRET;
  if (!apiKey || !apiSecret) return null;

  try {
    // Podcast Index API auth
    const now = Math.floor(Date.now() / 1000);
    const { createHash } = await import("node:crypto");
    const authHash = createHash("sha1")
      .update(`${apiKey}${apiSecret}${now}`)
      .digest("hex");

    const searchUrl = `https://api.podcastindex.org/api/1.0/search/byterm?q=${encodeURIComponent(showName)}`;
    const resp = await fetch(searchUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "X-Auth-Key": apiKey,
        "X-Auth-Date": String(now),
        Authorization: authHash,
        "User-Agent": "CherryAgent-Pod/1.0",
      },
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      feeds?: { url: string; title: string }[];
    };

    const feed = data.feeds?.[0];
    if (!feed?.url) return null;

    // Found the RSS feed, now resolve the episode
    const episodeMeta = await resolveRssEpisode(feed.url, episodeTitle);
    return episodeMeta.audioUrl ?? null;
  } catch {
    return null;
  }
}
