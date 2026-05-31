export const MONTHS_PER_WEEK = 4.333;

export interface BudgetCategory {
  id: string;
  label: string;
  buttonLabel: string;
  monthlyGoalCad: number;
  aliases: readonly string[];
}

export const BUDGET_CATEGORIES = [
  {
    id: "groceries",
    label: "Groceries",
    buttonLabel: "Groceries",
    monthlyGoalCad: 350,
    aliases: [
      "groceries",
      "grocery",
      "metro",
      "super c",
      "maxi",
      "chez robin",
      "provigo",
      "iga",
      "walmart grocery",
      "breakfast",
      "cleaning",
      "bathroom",
    ],
  },
  {
    id: "restaurants",
    label: "Restaurants & coffees",
    buttonLabel: "Restaurants",
    monthlyGoalCad: 180,
    aliases: [
      "restaurants",
      "restaurant",
      "coffee",
      "coffees",
      "starbucks",
      "tim hortons",
      "cafe",
      "brunch",
      "lunch",
      "dinner out",
      "takeout",
    ],
  },
  {
    id: "delivery",
    label: "Delivery (Uber Eats)",
    buttonLabel: "Delivery",
    monthlyGoalCad: 50,
    aliases: ["delivery", "uber eats", "ubereats", "door dash", "doordash"],
  },
  {
    id: "uber_rides",
    label: "Uber rides",
    buttonLabel: "Uber rides",
    monthlyGoalCad: 25,
    aliases: ["uber ride", "uber rides", "uber trip", "taxi", "cab", "lyft"],
  },
  {
    id: "amazon",
    label: "Amazon",
    buttonLabel: "Amazon",
    monthlyGoalCad: 147,
    aliases: ["amazon", "amazon.ca", "amzn", "cats", "cat litter", "supplements"],
  },
  {
    id: "subscriptions",
    label: "Subscriptions",
    buttonLabel: "Subscriptions",
    monthlyGoalCad: 92,
    aliases: [
      "subscription",
      "subscriptions",
      "prime",
      "amazon prime",
      "chatgpt",
      "openai",
      "claude",
      "google one",
      "youtube member",
      "youtube membership",
    ],
  },
  {
    id: "cinema",
    label: "Cinema",
    buttonLabel: "Cinema",
    monthlyGoalCad: 45,
    aliases: ["cinema", "cineplex", "movie", "movies", "popcorn"],
  },
  {
    id: "thrift",
    label: "Thrift",
    buttonLabel: "Thrift",
    monthlyGoalCad: 65,
    aliases: [
      "thrift",
      "secondhand",
      "second hand",
      "renaissance",
      "village des valeurs",
      "value village",
      "used clothes",
    ],
  },
  {
    id: "dollar_store",
    label: "Dollar store",
    buttonLabel: "Dollar store",
    monthlyGoalCad: 70,
    aliases: ["dollar store", "dollarama", "dollar tree", "dollar"],
  },
  {
    id: "home_hardware",
    label: "Home & hardware",
    buttonLabel: "Home/hardware",
    monthlyGoalCad: 40,
    aliases: [
      "home",
      "hardware",
      "canadian tire",
      "ikea",
      "home depot",
      "reno depot",
      "renodepot",
      "rona",
    ],
  },
  {
    id: "cash",
    label: "Cash",
    buttonLabel: "Cash",
    monthlyGoalCad: 45,
    aliases: ["cash", "atm", "withdrawal", "withdraw"],
  },
  {
    id: "personal",
    label: "Personal",
    buttonLabel: "Personal",
    monthlyGoalCad: 20,
    aliases: ["personal", "sqdc", "weed", "cannabis"],
  },
  {
    id: "summer_buffer",
    label: "Summer/concert buffer",
    buttonLabel: "Summer buffer",
    monthlyGoalCad: 40,
    aliases: [
      "summer",
      "concert",
      "concerts",
      "ticket",
      "tickets",
      "festival",
      "event",
      "show",
    ],
  },
] as const;

export type BudgetCategoryId = (typeof BUDGET_CATEGORIES)[number]["id"];

const CATEGORY_IDS = new Set<string>(BUDGET_CATEGORIES.map((category) => category.id));

export function isBudgetCategoryId(value: string): value is BudgetCategoryId {
  return CATEGORY_IDS.has(value);
}

export function getBudgetCategory(id: BudgetCategoryId): BudgetCategory {
  return BUDGET_CATEGORIES.find((category) => category.id === id)!;
}

export function getWeeklyGoalCad(category: BudgetCategory): number {
  return category.monthlyGoalCad / MONTHS_PER_WEEK;
}

export function getMonthlyVariableGoalCad(): number {
  return BUDGET_CATEGORIES.reduce(
    (sum, category) => sum + category.monthlyGoalCad,
    0,
  );
}

export function getWeeklyVariableGoalCad(): number {
  return getMonthlyVariableGoalCad() / MONTHS_PER_WEEK;
}

export function formatCad(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}$${abs.toFixed(2)}`;
}
