export interface VideoMetadata {
  title: string;
  authorName: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}

export interface FavoriteItem {
  id: number;
  url: string;
  title: string;
  authorName: string;
  thumbnailUrl?: string;
  savedAt: number;
}
