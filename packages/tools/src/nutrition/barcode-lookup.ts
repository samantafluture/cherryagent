import type { Tool, ToolResult } from "../types.js";

export const barcodeLookupTool: Tool = {
  name: "nutrition.barcodeLookup",
  description:
    "Look up nutrition info for a food product by barcode number. Returns calories, protein, carbs, fat per serving.",
  category: "http",
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
  permissions: [],
  requiresApproval: false,
  timeout: 10_000,

  async execute(params): Promise<ToolResult> {
    const barcode = params.barcode as string;

    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}?fields=product_name,brands,nutriments,serving_size`,
      {
        headers: {
          "User-Agent": "CherryAgent/1.0 (github.com/samantafluture/cherryagent)",
        },
      },
    );

    if (!res.ok) {
      return {
        success: false,
        output: `Product not found for barcode ${barcode}`,
      };
    }

    const data = (await res.json()) as {
      status: number;
      product?: {
        product_name?: string;
        brands?: string;
        serving_size?: string;
        nutriments?: Record<string, number>;
      };
    };

    if (data.status === 0 || !data.product) {
      return {
        success: false,
        output: `Product not found for barcode ${barcode}`,
      };
    }

    const p = data.product;
    const n = p.nutriments ?? {};

    return {
      success: true,
      output: JSON.stringify({
        foodName: p.product_name ?? "Unknown",
        brand: p.brands ?? "Unknown",
        servingSize: p.serving_size ?? "Unknown",
        calories: Math.round(
          n["energy-kcal_serving"] ?? n["energy-kcal_100g"] ?? 0,
        ),
        protein: Math.round(n.proteins_serving ?? n.proteins_100g ?? 0),
        carbs: Math.round(
          n.carbohydrates_serving ?? n.carbohydrates_100g ?? 0,
        ),
        fat: Math.round(n.fat_serving ?? n.fat_100g ?? 0),
        per: n["energy-kcal_serving"] ? "serving" : "100g",
      }),
    };
  },
};
