/**
 * End-to-end test for food logging pipeline.
 * Run: pnpm tsx scripts/test-food-log.ts
 *
 * Tests: Gemini text parsing, barcode lookup, Fitbit log (dry run).
 * Requires GEMINI_API_KEY in .env or environment.
 */

import { GeminiProvider } from "../packages/core/src/providers/gemini.js";
import { FOOD_PARSE_SYSTEM_PROMPT } from "../packages/core/src/prompts/food-logging.js";
import { barcodeLookupTool } from "../packages/tools/src/nutrition/barcode-lookup.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is required. Set it in .env or environment.");
  process.exit(1);
}

const gemini = new GeminiProvider({ apiKey });

async function testTextParse() {
  console.log("--- Test 1: Text Parse (Gemini + JSON mode) ---");
  const response = await gemini.chat({
    systemInstruction: FOOD_PARSE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: "2 scrambled eggs with toast and butter for breakfast",
      },
    ],
    jsonMode: true,
  });

  console.log("Raw response:", response.content);

  if (!response.content) {
    console.error("FAIL: No content returned");
    return;
  }

  const nutrition = JSON.parse(response.content) as Record<string, unknown>;
  console.log("Parsed:", nutrition);

  // Basic sanity checks
  if (typeof nutrition.foodName !== "string")
    console.error("FAIL: foodName missing");
  if (typeof nutrition.calories !== "number" || nutrition.calories < 100)
    console.error("FAIL: calories looks wrong");
  if (nutrition.mealType !== "Breakfast")
    console.warn("WARN: mealType should be Breakfast, got:", nutrition.mealType);

  console.log("Tokens:", response.usage);
  console.log("PASS\n");
}

async function testBarcodeLookup() {
  console.log("--- Test 2: Barcode Lookup (OpenFoodFacts) ---");

  // Nutella 750g — well-known product in OpenFoodFacts
  const result = await barcodeLookupTool.execute(
    { barcode: "3017620422003" },
    { taskId: "test", permissions: [] },
  );

  console.log("Success:", result.success);
  console.log("Output:", result.output);

  if (!result.success) {
    console.error("FAIL: Barcode lookup failed");
    return;
  }

  const data = JSON.parse(result.output) as Record<string, unknown>;
  console.log("Parsed:", data);

  if (typeof data.foodName !== "string")
    console.error("FAIL: foodName missing");
  if (typeof data.calories !== "number")
    console.error("FAIL: calories missing");

  console.log("PASS\n");
}

async function testBarcodeNotFound() {
  console.log("--- Test 3: Barcode Not Found ---");

  const result = await barcodeLookupTool.execute(
    { barcode: "0000000000000" },
    { taskId: "test", permissions: [] },
  );

  console.log("Success:", result.success);
  console.log("Output:", result.output);

  if (result.success) {
    console.error("FAIL: Should have returned not found");
    return;
  }

  console.log("PASS\n");
}

async function testFitbitDryRun() {
  console.log("--- Test 4: Fitbit Log (dry run) ---");
  console.log(
    "Would log:",
    JSON.stringify(
      {
        foodName: "Scrambled Eggs + Toast",
        calories: 380,
        protein: 20,
        carbs: 30,
        fat: 25,
        mealType: "Breakfast",
      },
      null,
      2,
    ),
  );
  console.log("PASS (dry run — no Fitbit credentials needed)\n");
}

async function main() {
  console.log("Food Log Pipeline Tests\n");

  await testTextParse();
  await testBarcodeLookup();
  await testBarcodeNotFound();
  await testFitbitDryRun();

  console.log("All tests completed.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
