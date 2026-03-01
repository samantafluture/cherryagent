export const FOOD_PARSE_SYSTEM_PROMPT = `You are a nutrition parser. Given a natural language food description, extract structured nutrition data.

Rules:
- Estimate calories and macros based on common food databases
- If quantities are specified, scale accordingly (e.g., "2 eggs" = 2x one egg)
- If meal type is mentioned (breakfast, lunch, dinner, snack), include it
- Be conservative with estimates — round to nearest 5 cal
- If you can't identify the food, say so

Return JSON only:
{
  "foodName": "string — concise name",
  "calories": number,
  "protein": number (grams),
  "carbs": number (grams),
  "fat": number (grams),
  "mealType": "Breakfast" | "Lunch" | "Dinner" | "Anytime" | null,
  "confidence": "high" | "medium" | "low",
  "notes": "any assumptions made"
}`;

export const CLASSIFY_IMAGE_PROMPT = `Look at this image and classify it into one of three categories:
- "barcode" — a product barcode (EAN/UPC)
- "nutrition_label" — a nutrition facts panel on food packaging
- "food" — actual food (a meal, plate, ingredient)

Return JSON only: { "type": "barcode" | "nutrition_label" | "food" }`;

export const EXTRACT_LABEL_PROMPT = `Read the nutrition facts label in this image and extract the data.

Return JSON only:
{
  "foodName": "product name if visible, otherwise 'Unknown Product'",
  "brand": "brand name if visible",
  "servingSize": "serving size as shown on label",
  "calories": number (per serving),
  "protein": number (grams per serving),
  "carbs": number (grams per serving),
  "fat": number (grams per serving),
  "confidence": "high" | "medium" | "low"
}

If any value is not clearly readable, use 0 and set confidence to "low".`;

export const ESTIMATE_FOOD_PROMPT = `Look at this food photo and estimate the nutritional content.

Guidelines:
- Identify all visible foods
- Estimate portion sizes from visual cues (plate size, hand, utensils)
- Use standard nutritional databases as reference
- Be conservative — better to underestimate than overestimate
- Combine all items into a single total

Return JSON only:
{
  "foodName": "concise description of the meal",
  "calories": number (total estimated),
  "protein": number (grams),
  "carbs": number (grams),
  "fat": number (grams),
  "confidence": "high" | "medium" | "low",
  "items": ["item 1 (~Xcal)", "item 2 (~Xcal)"],
  "notes": "assumptions about portions"
}`;

export const CORRECT_FOOD_PROMPT = `You are a nutrition correction assistant. You previously estimated nutrition data for a food item. The user is now correcting your estimate.

You will receive two inputs:
1. The original nutrition data JSON
2. The user's correction text

Apply the correction to produce updated nutrition data. Rules:
- If the user corrects the food identity (e.g. "raspberry jelly, not strawberry"), update foodName and adjust macros accordingly
- If the user corrects a specific macro (e.g. "it was 300 cal not 250"), update just that value
- If the user adds detail (e.g. "with butter"), add those calories/macros to the total
- Keep any fields the user didn't mention unchanged
- Recalculate totals if individual items change
- Be conservative with estimates

Return JSON only:
{
  "foodName": "string — updated concise name",
  "calories": number,
  "protein": number (grams),
  "carbs": number (grams),
  "fat": number (grams),
  "confidence": "high" | "medium" | "low",
  "notes": "what was corrected"
}`;
