import {
  BUDGET_CATEGORIES,
  type BudgetCategoryId,
} from "./categories.js";

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalizeText(text)} `;
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  return normalizedText.includes(` ${normalizedPhrase} `);
}

export function inferBudgetCategories(text: string): BudgetCategoryId[] {
  const matches = new Set<BudgetCategoryId>();
  const normalized = normalizeText(text);

  for (const category of BUDGET_CATEGORIES) {
    for (const alias of category.aliases) {
      if (containsPhrase(normalized, alias)) {
        matches.add(category.id);
        break;
      }
    }
  }

  if (containsPhrase(normalized, "uber") && !containsPhrase(normalized, "uber eats")) {
    matches.add("uber_rides");
  }

  if (containsPhrase(normalized, "amazon prime")) {
    matches.delete("amazon");
    matches.add("subscriptions");
  }

  return [...matches];
}
