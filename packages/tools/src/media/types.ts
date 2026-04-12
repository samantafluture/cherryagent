export interface VideoMetadata {
  title: string;
  authorName: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}

export interface PodcastMetadata {
  title: string;
  showName: string;
  authorName?: string;
  audioUrl?: string;
  episodeUrl?: string;
  description?: string;
}

export interface FavoriteItem {
  id: number;
  url: string;
  title: string;
  authorName: string;
  thumbnailUrl?: string;
  savedAt: number;
}
