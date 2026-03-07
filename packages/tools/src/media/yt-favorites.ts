import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { FavoriteItem } from "./types.js";

const FAVORITES_DIR = join(homedir(), ".cherryagent");
const FAVORITES_PATH = join(FAVORITES_DIR, "yt-favorites.json");

async function readFavorites(): Promise<FavoriteItem[]> {
  try {
    const raw = await readFile(FAVORITES_PATH, "utf-8");
    return JSON.parse(raw) as FavoriteItem[];
  } catch {
    return [];
  }
}

async function writeFavorites(items: FavoriteItem[]): Promise<void> {
  await mkdir(FAVORITES_DIR, { recursive: true });
  await writeFile(FAVORITES_PATH, JSON.stringify(items, null, 2), "utf-8");
}

function nextId(items: FavoriteItem[]): number {
  if (items.length === 0) return 1;
  return Math.max(...items.map((i) => i.id)) + 1;
}

export async function addFavorite(
  url: string,
  title: string,
  authorName: string,
  thumbnailUrl?: string,
): Promise<{ item: FavoriteItem; alreadyExisted: boolean }> {
  const items = await readFavorites();
  const existing = items.find((i) => i.url === url);
  if (existing) {
    return { item: existing, alreadyExisted: true };
  }

  const item: FavoriteItem = {
    id: nextId(items),
    url,
    title,
    authorName,
    thumbnailUrl,
    savedAt: Date.now(),
  };
  items.push(item);
  await writeFavorites(items);
  return { item, alreadyExisted: false };
}

export async function listFavorites(): Promise<FavoriteItem[]> {
  return readFavorites();
}

export async function getFavoriteByIndex(index: number): Promise<FavoriteItem | undefined> {
  const items = await readFavorites();
  return items[index - 1];
}

export async function removeFavoriteByIndex(index: number): Promise<FavoriteItem | undefined> {
  const items = await readFavorites();
  if (index < 1 || index > items.length) return undefined;
  const [removed] = items.splice(index - 1, 1);
  await writeFavorites(items);
  return removed;
}
