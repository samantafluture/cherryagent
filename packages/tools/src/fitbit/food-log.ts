import type { Tool, ToolResult } from "../types.js";
import type { FitbitAuth } from "./auth.js";

const MEAL_TYPE_MAP: Record<string, number> = {
  Breakfast: 1,
  "Morning Snack": 2,
  Lunch: 3,
  "Afternoon Snack": 4,
  Dinner: 5,
  Anytime: 7,
};

export function createFitbitLogFoodTool(auth: FitbitAuth): Tool {
  return {
    name: "fitbit.logFood",
    description:
      "Log a food entry to Fitbit. Requires food name, calories, and macros. Optionally specify meal type.",
    category: "http",
    parameters: {
      type: "object",
      properties: {
        foodName: { type: "string", description: "Name of the food" },
        calories: { type: "number", description: "Total calories" },
        protein: { type: "number", description: "Protein in grams" },
        carbs: { type: "number", description: "Carbohydrates in grams" },
        fat: { type: "number", description: "Fat in grams" },
        mealType: {
          type: "string",
          enum: [
            "Breakfast",
            "Morning Snack",
            "Lunch",
            "Afternoon Snack",
            "Dinner",
            "Anytime",
          ],
          description:
            "Meal type. Infer from context or time of day if not specified.",
        },
        amount: {
          type: "number",
          description: "Number of servings (default 1)",
        },
      },
      required: ["foodName", "calories"],
    },
    permissions: [],
    requiresApproval: false,
    timeout: 15_000,

    async execute(params): Promise<ToolResult> {
      const foodName = params.foodName as string;
      const calories = params.calories as number;
      const protein = params.protein as number | undefined;
      const carbs = params.carbs as number | undefined;
      const fat = params.fat as number | undefined;
      const mealType = (params.mealType as string) ?? "Anytime";
      const amount = (params.amount as number) ?? 1;

      let token: string;
      try {
        token = await auth.getAccessToken();
      } catch (err) {
        return {
          success: false,
          output:
            err instanceof Error
              ? err.message
              : "Failed to get Fitbit access token",
        };
      }

      // Use local date, not UTC — otherwise entries land on "tomorrow"
      // when logging after midnight UTC but before midnight local time
      const now = new Date();
      const today = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      ].join("-");

      const body = new URLSearchParams({
        foodName,
        calories: String(Math.round(calories)),
        mealTypeId: String(MEAL_TYPE_MAP[mealType] ?? 7),
        unitId: "304", // serving
        amount: String(amount),
        date: today,
      });

      if (protein != null)
        body.append("protein", String(Math.round(protein)));
      if (carbs != null)
        body.append("totalCarbohydrate", String(Math.round(carbs)));
      if (fat != null)
        body.append("totalFat", String(Math.round(fat)));

      const res = await fetch(
        "https://api.fitbit.com/1/user/-/foods/log.json",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        },
      );

      if (!res.ok) {
        const error = await res.text();
        return {
          success: false,
          output: `Fitbit API error ${res.status}: ${error}`,
        };
      }

      const result = (await res.json()) as {
        foodLog?: { logId?: string };
      };

      return {
        success: true,
        output: `Logged "${foodName}" (${Math.round(calories)} cal) to Fitbit as ${mealType}`,
        sideEffects: [`fitbit:food_log:${result.foodLog?.logId ?? "unknown"}`],
      };
    },
  };
}
