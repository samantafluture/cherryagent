import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { NutritionData, FoodFavorite } from "./types.js";

const FAVORITES_DIR = join(homedir(), ".cherryagent");
const FAVORITES_PATH = join(FAVORITES_DIR, "food-favorites.json");

async function readFavorites(): Promise<FoodFavorite[]> {
  try {
    const raw = await readFile(FAVORITES_PATH, "utf-8");
    return JSON.parse(raw) as FoodFavorite[];
  } catch {
    return [];
  }
}

async function writeFavorites(items: FoodFavorite[]): Promise<void> {
  await mkdir(FAVORITES_DIR, { recursive: true });
  await writeFile(FAVORITES_PATH, JSON.stringify(items, null, 2), "utf-8");
}

function nextId(items: FoodFavorite[]): number {
  if (items.length === 0) return 1;
  return Math.max(...items.map((i) => i.id)) + 1;
}

export async function addFoodFavorite(
  nutrition: NutritionData,
): Promise<{ item: FoodFavorite; alreadyExisted: boolean }> {
  const items = await readFavorites();
  const existing = items.find((i) => i.nutrition.foodName === nutrition.foodName);
  if (existing) {
    return { item: existing, alreadyExisted: true };
  }

  const item: FoodFavorite = {
    id: nextId(items),
    nutrition,
    savedAt: Date.now(),
  };
  items.push(item);
  await writeFavorites(items);
  return { item, alreadyExisted: false };
}

export async function listFoodFavorites(): Promise<FoodFavorite[]> {
  return readFavorites();
}

export async function getFoodFavoriteByIndex(index: number): Promise<FoodFavorite | undefined> {
  const items = await readFavorites();
  return items[index - 1];
}

export async function removeFoodFavoriteByIndex(index: number): Promise<FoodFavorite | undefined> {
  const items = await readFavorites();
  if (index < 1 || index > items.length) return undefined;
  const [removed] = items.splice(index - 1, 1);
  await writeFavorites(items);
  return removed;
}
