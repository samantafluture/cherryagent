/**
 * Test script for the Gemini provider.
 * Run: pnpm tsx scripts/test-gemini.ts
 *
 * Requires GEMINI_API_KEY in .env or environment.
 */

import { GeminiProvider } from "../packages/core/src/providers/gemini.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is required. Set it in .env or environment.");
  process.exit(1);
}

const gemini = new GeminiProvider({ apiKey });

async function testBasicChat() {
  console.log("--- Test 1: Basic chat ---");
  const response = await gemini.chat({
    messages: [{ role: "user", content: "What is 2 + 2? Reply with just the number." }],
  });
  console.log("Content:", response.content);
  console.log("Tokens:", response.usage);
  console.log("Finish:", response.finishReason);
  console.log();
}

async function testSystemInstruction() {
  console.log("--- Test 2: System instruction (food parsing) ---");
  const response = await gemini.chat({
    systemInstruction: `You are a nutrition parser. Given a food description, extract structured nutrition data.
Return JSON only:
{
  "foodName": "string",
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "mealType": "Breakfast" | "Lunch" | "Dinner" | "Anytime" | null,
  "confidence": "high" | "medium" | "low"
}`,
    messages: [
      { role: "user", content: "2 scrambled eggs with toast and butter for breakfast" },
    ],
    jsonMode: true,
  });
  console.log("Content:", response.content);
  console.log("Tokens:", response.usage);
  console.log();
}

async function testJsonSchema() {
  console.log("--- Test 3: JSON schema (structured output) ---");
  const response = await gemini.chat({
    messages: [
      { role: "user", content: "A medium banana" },
    ],
    systemInstruction: "Extract nutrition data for the given food.",
    jsonSchema: {
      type: "object",
      properties: {
        foodName: { type: "string" },
        calories: { type: "number" },
        protein: { type: "number" },
        carbs: { type: "number" },
        fat: { type: "number" },
      },
      required: ["foodName", "calories", "protein", "carbs", "fat"],
    },
  });
  console.log("Content:", response.content);
  console.log("Tokens:", response.usage);
  console.log();
}

async function testToolCalling() {
  console.log("--- Test 4: Tool calling ---");
  const response = await gemini.chat({
    systemInstruction:
      "You are a food logging assistant. Use the barcode_lookup tool when the user provides a barcode number.",
    messages: [{ role: "user", content: "Look up barcode 7622210449283" }],
    tools: [
      {
        name: "barcode_lookup",
        description:
          "Look up nutrition info for a food product by barcode number.",
        parameters: {
          type: "object",
          properties: {
            barcode: {
              type: "string",
              description: "EAN/UPC barcode number (8 or 13 digits)",
            },
          },
          required: ["barcode"],
        },
      },
    ],
  });
  console.log("Content:", response.content);
  console.log("Tool calls:", JSON.stringify(response.toolCalls, null, 2));
  console.log("Finish:", response.finishReason);
  console.log("Tokens:", response.usage);
  console.log();
}

async function main() {
  console.log(`Provider: ${gemini.id}`);
  console.log(`Tier: ${gemini.tier}`);
  console.log();

  await testBasicChat();
  await testSystemInstruction();
  await testJsonSchema();
  await testToolCalling();

  console.log("All tests passed.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
