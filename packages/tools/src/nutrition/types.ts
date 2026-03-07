export interface NutritionData {
  foodName: string;
  brand?: string;
  servingSize?: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  saturatedFat?: number;
  mealType?:
    | "Breakfast"
    | "Morning Snack"
    | "Lunch"
    | "Afternoon Snack"
    | "Dinner"
    | "Anytime";
  confidence?: "high" | "medium" | "low";
  items?: string[];
  notes?: string;
}

export interface FoodFavorite {
  id: number;
  nutrition: NutritionData;
  savedAt: number;
}
