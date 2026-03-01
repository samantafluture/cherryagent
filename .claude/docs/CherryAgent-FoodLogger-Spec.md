# CherryAgent — Food Logger Workflow (First Build)

**Version:** 1.0  
**Date:** February 28, 2026  
**Status:** Draft  
**Context:** This is the first CherryAgent workflow. It bootstraps the agent core alongside the food logging feature.

---

## 1. What We're Building

A Telegram-based food logger that posts nutrition data to Fitbit's Food Log API. Four input methods:

| Input | Flow | LLM Role |
|-------|------|----------|
| **Text** | "2 eggs and toast for breakfast" | Parse food → estimate nutrition → confirm → log |
| **Barcode** | Send number or photo of barcode | Extract number → OpenFoodFacts lookup → confirm → log |
| **Label photo** | Send photo of nutrition label | Vision: read macros from image → confirm → log |
| **Food photo** | Send photo of a meal | Vision: identify food + estimate macros → confirm → log |

All four flows converge on the same confirmation + Fitbit API call.

---

## 2. Why Gemini 2.5 Flash

| Factor | Gemini 2.5 Flash | Notes |
|--------|-------------------|-------|
| Multimodal | ✅ Native vision | Reads labels, identifies food, extracts barcodes from photos |
| Structured output | ✅ JSON mode | Forces `{ foodName, calories, protein, carbs, fat }` reliably |
| Function calling | ✅ Native | Supports `FunctionDeclaration` for tool orchestration |
| Speed | ~0.5-1s for simple tasks | Great for quick food logs |
| Cost | ~$0.15/1M input, $0.60/1M output (thinking off) | A food log costs fractions of a cent |
| Free tier | ~1,500 RPD | Covers most daily usage for free |

**Important — Thinking mode:** Gemini 2.5 Flash has an optional "thinking" mode that increases quality but also cost ($0.30/$2.50 with thinking). For food logging, **thinking should be OFF** — these are simple extraction tasks, not complex reasoning. Set `generationConfig: { thinkingConfig: { thinkingBudget: 0 } }` or simply don't enable it.

---

## 3. Architecture Overview

```
┌──────────────┐     ┌──────────────────────────────────┐     ┌──────────────┐
│   Telegram   │────▶│         CherryAgent Core         │────▶│  Fitbit API  │
│  (Sam sends  │     │                                  │     │  Food Log    │
│  text/photo) │◀────│  Gemini 2.5 Flash (vision + NLU) │     │              │
│              │     │  OpenFoodFacts API (barcode)      │     │              │
└──────────────┘     │  Confirm flow (ask_user)          │     └──────────────┘
                     └──────────────────────────────────┘
```

This builds on your CherryAgent Technical Design. We're implementing a **vertical slice** — enough of the agent core to run this single workflow end-to-end, then expanding later.

---

## 4. What to Build (Scoped Milestones)

Instead of building the full M1→M6 pipeline and then adding food logging, we build the **minimum agent** needed for this workflow, then expand.

### Phase A — Skeleton + Gemini Provider (3-4h)

Everything from your M1 + just the Gemini provider from M2.

```
cherry-agent/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── providers/
│   │   │   │   ├── types.ts              # LLMProvider, LLMResponse interfaces
│   │   │   │   ├── gemini.ts             # Gemini 2.5 Flash adapter
│   │   │   │   └── registry.ts           # Provider registry (just Gemini for now)
│   │   │   ├── agent/
│   │   │   │   ├── loop.ts               # Simplified agent loop
│   │   │   │   └── system-prompt.ts      # System prompt builder
│   │   │   └── index.ts
│   │   └── package.json
│   ├── tools/
│   │   ├── src/
│   │   │   ├── framework/
│   │   │   │   ├── types.ts              # Tool, ToolResult interfaces
│   │   │   │   ├── registry.ts           # Tool registry
│   │   │   │   └── executor.ts           # Tool executor (simplified)
│   │   │   ├── fitbit/
│   │   │   │   ├── auth.ts               # OAuth2 flow + token refresh
│   │   │   │   ├── food-log.ts           # fitbit.logFood tool
│   │   │   │   └── types.ts              # Fitbit API types
│   │   │   ├── nutrition/
│   │   │   │   ├── barcode-lookup.ts     # openfoodfacts.lookup tool
│   │   │   │   └── types.ts              # Nutrition data types
│   │   │   └── index.ts
│   │   └── package.json
│   └── api/
│       ├── src/
│       │   ├── server.ts                 # Fastify entry
│       │   ├── telegram/
│       │   │   ├── bot.ts                # grammy bot setup
│       │   │   ├── handlers/
│       │   │   │   └── food-log.ts       # Food log message handler
│       │   │   └── middleware.ts          # Auth (chat ID check)
│       │   └── routes/
│       │       └── health.ts
│       └── package.json
├── docker-compose.dev.yml                # Postgres + Redis
├── .env.example
└── package.json
```

**What we skip for now:** Cost router (hardcode Gemini), BullMQ queue (inline execution), memory system, skill system, permission engine, approval gates. All designed in your docs, all added later — the interfaces stay compatible.

### Phase B — Gemini Integration + Food Tools (4-5h)

#### B.1 — Gemini 2.5 Flash Provider

```typescript
// packages/core/src/providers/gemini.ts
import { GoogleGenAI } from '@google/genai';

// Using the NEW @google/genai SDK (not the deprecated @google/generative-ai)
// Docs: https://github.com/googleapis/js-genai

export class GeminiProvider implements LLMProvider {
  id = 'gemini-2.5-flash';
  tier = 2 as const;
  
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    systemInstruction?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<LLMResponse> {
    
    // Convert your unified tool format to Gemini FunctionDeclarations
    const geminiTools = params.tools?.length ? [{
      functionDeclarations: params.tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters // JSON Schema → Gemini accepts this directly
      }))
    }] : undefined;

    // Convert unified messages to Gemini format
    const contents = this.convertMessages(params.messages);

    const response = await this.client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: {
        tools: geminiTools,
        systemInstruction: params.systemInstruction,
        temperature: params.temperature ?? 0.3,
        maxOutputTokens: params.maxTokens ?? 1024,
        // IMPORTANT: Disable thinking for cheap, fast food logging
        thinkingConfig: { thinkingBudget: 0 },
        // Force JSON when no tools are provided but we want structured output
        // (used for vision extraction)
      }
    });

    return this.normalizeResponse(response);
  }

  // For vision tasks (label/food photos)
  async chatWithImage(params: {
    prompt: string;
    imageBase64: string;
    mimeType: string; // 'image/jpeg' | 'image/png'
    tools?: ToolDefinition[];
    systemInstruction?: string;
    jsonMode?: boolean;
  }): Promise<LLMResponse> {

    const contents = [{
      role: 'user' as const,
      parts: [
        { inlineData: { data: params.imageBase64, mimeType: params.mimeType } },
        { text: params.prompt }
      ]
    }];

    const config: Record<string, any> = {
      systemInstruction: params.systemInstruction,
      temperature: 0.2, // Low temp for extraction accuracy
      maxOutputTokens: 512,
      thinkingConfig: { thinkingBudget: 0 },
    };

    if (params.jsonMode) {
      config.responseMimeType = 'application/json';
    }

    if (params.tools?.length) {
      config.tools = [{
        functionDeclarations: params.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }))
      }];
    }

    const response = await this.client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config,
    });

    return this.normalizeResponse(response);
  }

  private convertMessages(messages: Message[]): GeminiContent[] {
    return messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
  }

  private normalizeResponse(response: any): LLMResponse {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    
    const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text);
    const functionCalls = parts.filter((p: any) => p.functionCall);

    return {
      content: textParts.join('') || null,
      toolCalls: functionCalls.length > 0
        ? functionCalls.map((fc: any) => ({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: fc.functionCall.name,
            arguments: fc.functionCall.args,
          }))
        : null,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount || 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
      },
      finishReason: functionCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }
}
```

#### B.2 — OpenFoodFacts Barcode Lookup Tool

```typescript
// packages/tools/src/nutrition/barcode-lookup.ts

export const barcodeLookupTool: Tool = {
  name: 'nutrition.barcodeLookup',
  description: 'Look up nutrition info for a food product by barcode number. Returns calories, protein, carbs, fat per serving.',
  category: 'http',
  parameters: {
    type: 'object',
    properties: {
      barcode: { type: 'string', description: 'EAN/UPC barcode number (8 or 13 digits)' }
    },
    required: ['barcode']
  },
  permissions: [],
  requiresApproval: false,
  timeout: 10_000,

  async execute(params): Promise<ToolResult> {
    const { barcode } = params;
    
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}?fields=product_name,brands,nutriments,serving_size`,
      { headers: { 'User-Agent': 'CherryAgent/1.0 (sam@cherryagent.dev)' } }
    );

    if (!res.ok || res.status === 404) {
      return { success: false, output: `Product not found for barcode ${barcode}` };
    }

    const data = await res.json();
    if (data.status === 0) {
      return { success: false, output: `Product not found for barcode ${barcode}` };
    }

    const p = data.product;
    const n = p.nutriments || {};

    return {
      success: true,
      output: JSON.stringify({
        foodName: p.product_name || 'Unknown',
        brand: p.brands || 'Unknown',
        servingSize: p.serving_size || 'Unknown',
        calories: Math.round(n['energy-kcal_serving'] || n['energy-kcal_100g'] || 0),
        protein: Math.round(n.proteins_serving || n.proteins_100g || 0),
        carbs: Math.round(n.carbohydrates_serving || n.carbohydrates_100g || 0),
        fat: Math.round(n.fat_serving || n.fat_100g || 0),
        per: n['energy-kcal_serving'] ? 'serving' : '100g',
      })
    };
  }
};
```

#### B.3 — Fitbit Food Log Tool

```typescript
// packages/tools/src/fitbit/food-log.ts

export const fitbitLogFoodTool: Tool = {
  name: 'fitbit.logFood',
  description: 'Log a food entry to Fitbit. Requires food name, calories, and macros. Optionally specify meal type.',
  category: 'http',
  parameters: {
    type: 'object',
    properties: {
      foodName:  { type: 'string', description: 'Name of the food' },
      calories:  { type: 'number', description: 'Total calories' },
      protein:   { type: 'number', description: 'Protein in grams' },
      carbs:     { type: 'number', description: 'Carbohydrates in grams' },
      fat:       { type: 'number', description: 'Fat in grams' },
      mealType:  { 
        type: 'string', 
        enum: ['Breakfast', 'Morning Snack', 'Lunch', 'Afternoon Snack', 'Dinner', 'Anytime'],
        description: 'Meal type. Infer from context or time of day if not specified.' 
      },
      amount:    { type: 'number', description: 'Number of servings (default 1)', default: 1 },
      unitId:    { type: 'number', description: 'Fitbit unit ID (default 304 = serving)', default: 304 },
    },
    required: ['foodName', 'calories']
  },
  permissions: [],
  requiresApproval: false,  // Sam confirms via ask_user BEFORE this tool runs
  timeout: 15_000,

  async execute(params, context): Promise<ToolResult> {
    const token = await context.credentials.getAccessToken('fitbit');
    
    const mealTypeMap: Record<string, number> = {
      'Breakfast': 1, 'Morning Snack': 2, 'Lunch': 3,
      'Afternoon Snack': 4, 'Dinner': 5, 'Anytime': 7,
    };

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const body = new URLSearchParams({
      foodName: params.foodName,
      calories: String(Math.round(params.calories)),
      mealTypeId: String(mealTypeMap[params.mealType || 'Anytime'] || 7),
      unitId: String(params.unitId || 304),
      amount: String(params.amount || 1),
      date: today,
    });

    // Add optional macros (Fitbit supports these as "nutritionalValues")
    if (params.protein) body.append('protein', String(Math.round(params.protein)));
    if (params.carbs) body.append('totalCarbohydrate', String(Math.round(params.carbs)));
    if (params.fat) body.append('totalFat', String(Math.round(params.fat)));

    const res = await fetch('https://api.fitbit.com/1/user/-/foods/log.json', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const error = await res.text();
      return { success: false, output: `Fitbit API error ${res.status}: ${error}` };
    }

    const result = await res.json();
    return {
      success: true,
      output: `✅ Logged "${params.foodName}" (${Math.round(params.calories)} cal) to Fitbit as ${params.mealType || 'Anytime'}`,
      sideEffects: [`fitbit:food_log:${result.foodLog?.logId}`],
    };
  }
};
```

#### B.4 — Fitbit OAuth2 Handler

Fitbit uses OAuth2 Authorization Code Grant with PKCE. This is a one-time browser flow, then token refresh handles everything.

```typescript
// packages/tools/src/fitbit/auth.ts

interface FitbitTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp
}

export class FitbitAuth {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private tokens: FitbitTokens | null = null;

  constructor(config: { clientId: string; clientSecret: string; redirectUri: string }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
  }

  // Step 1: Generate authorization URL (one-time, open in browser)
  getAuthUrl(): string {
    const scopes = 'nutrition'; // Only need nutrition scope for food logging
    return `https://www.fitbit.com/oauth2/authorize?` +
      `response_type=code&client_id=${this.clientId}` +
      `&redirect_uri=${encodeURIComponent(this.redirectUri)}` +
      `&scope=${scopes}` +
      `&expires_in=604800`; // 7 days token lifetime
  }

  // Step 2: Exchange authorization code for tokens (one-time callback)
  async exchangeCode(code: string): Promise<void> {
    const res = await fetch('https://api.fitbit.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
      }).toString(),
    });

    const data = await res.json();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };
    
    await this.persistTokens(); // Save to DB or encrypted file
  }

  // Step 3: Get valid access token (auto-refreshes if expired)
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      await this.loadTokens(); // Load from DB
    }
    if (!this.tokens) {
      throw new Error('Fitbit not authorized. Run /fitbit-auth to connect.');
    }

    // Refresh if expired or expiring within 5 minutes
    if (Date.now() > this.tokens.expiresAt - 300_000) {
      await this.refreshTokens();
    }

    return this.tokens.accessToken;
  }

  private async refreshTokens(): Promise<void> {
    const res = await fetch('https://api.fitbit.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens!.refreshToken,
      }).toString(),
    });

    const data = await res.json();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };

    await this.persistTokens();
  }

  private async persistTokens(): Promise<void> {
    // Store in PostgreSQL (encrypted) or Redis
    // For Phase A: store in a JSON file (migrate to DB later)
  }

  private async loadTokens(): Promise<void> {
    // Load from PostgreSQL or fallback to JSON file
  }
}
```

### Phase C — Telegram Bot + Conversation Flow (4-5h)

#### C.1 — Grammy Bot Setup

```typescript
// packages/api/src/telegram/bot.ts
import { Bot, Context, InputFile } from 'grammy';

export function createBot(token: string, authorizedChatId: string) {
  const bot = new Bot(token);

  // Security: only respond to Sam
  bot.use(async (ctx, next) => {
    if (String(ctx.chat?.id) !== authorizedChatId) return;
    await next();
  });

  // Commands
  bot.command('start', ctx => ctx.reply('🍒 CherryAgent ready. Send food to log!'));
  bot.command('fitbit_auth', handleFitbitAuth);

  // Photo handler (label, food photo, or barcode photo)
  bot.on('message:photo', handlePhotoMessage);

  // Text handler (manual input or barcode number)
  bot.on('message:text', handleTextMessage);

  // Callback queries (confirmation buttons)
  bot.on('callback_query:data', handleCallback);

  return bot;
}
```

#### C.2 — Food Log Conversation Flow

This is the core UX. Every input method converges on the same confirm → log flow.

```typescript
// packages/api/src/telegram/handlers/food-log.ts

// ─── State management (in-memory for now, Redis later) ───
interface PendingLog {
  chatId: string;
  nutrition: NutritionData;
  source: 'text' | 'barcode' | 'label_photo' | 'food_photo';
  createdAt: number;
}

const pendingLogs = new Map<string, PendingLog>(); // chatId → pending

// ─── FLOW 1: Text input ───
async function handleTextMessage(ctx: Context) {
  const text = ctx.message!.text!;

  // Check if it's a barcode number (8 or 13 digits)
  if (/^\d{8,13}$/.test(text.trim())) {
    return handleBarcode(ctx, text.trim());
  }

  // Otherwise: natural language food description
  const gemini = getGeminiProvider();
  
  const response = await gemini.chat({
    systemInstruction: FOOD_PARSE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  // Gemini returns structured JSON via function calling or JSON mode
  const nutrition = parseNutritionFromLLM(response);
  
  if (!nutrition) {
    return ctx.reply("Couldn't parse that as food. Try: '2 eggs and toast for breakfast'");
  }

  return showConfirmation(ctx, nutrition, 'text');
}

// ─── FLOW 2: Barcode ───
async function handleBarcode(ctx: Context, barcode: string) {
  const result = await barcodeLookupTool.execute({ barcode });
  
  if (!result.success) {
    return ctx.reply(`❌ Product not found for barcode ${barcode}. Try sending a photo of the nutrition label instead.`);
  }

  const nutrition = JSON.parse(result.output) as NutritionData;
  return showConfirmation(ctx, nutrition, 'barcode');
}

// ─── FLOW 3: Photo (label, food, or barcode photo) ───
async function handlePhotoMessage(ctx: Context) {
  const photo = ctx.message!.photo!;
  const largest = photo[photo.length - 1]; // Highest resolution
  
  // Download photo from Telegram
  const file = await ctx.api.getFile(largest.file_id);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const imageBuffer = await fetch(url).then(r => r.arrayBuffer());
  const base64 = Buffer.from(imageBuffer).toString('base64');

  const gemini = getGeminiProvider();

  // Step 1: Classify the image
  const classifyResponse = await gemini.chatWithImage({
    prompt: CLASSIFY_IMAGE_PROMPT, // "Is this a barcode, nutrition label, or food?"
    imageBase64: base64,
    mimeType: 'image/jpeg',
    jsonMode: true,
  });

  const classification = JSON.parse(classifyResponse.content || '{}');

  switch (classification.type) {
    case 'barcode':
      // Extract barcode number from image, then look up
      const barcodeResponse = await gemini.chatWithImage({
        prompt: 'Extract the barcode number from this image. Return ONLY the digits.',
        imageBase64: base64,
        mimeType: 'image/jpeg',
      });
      const barcodeNumber = barcodeResponse.content?.trim().replace(/\D/g, '');
      if (barcodeNumber && /^\d{8,13}$/.test(barcodeNumber)) {
        return handleBarcode(ctx, barcodeNumber);
      }
      return ctx.reply("Couldn't read the barcode clearly. Try typing the number manually.");

    case 'nutrition_label':
      // Extract macros directly from label
      const labelResponse = await gemini.chatWithImage({
        prompt: EXTRACT_LABEL_PROMPT, // Detailed prompt for reading nutrition facts
        imageBase64: base64,
        mimeType: 'image/jpeg',
        jsonMode: true,
      });
      const labelNutrition = JSON.parse(labelResponse.content || '{}');
      return showConfirmation(ctx, labelNutrition, 'label_photo');

    case 'food':
      // Estimate nutrition from food photo
      const foodResponse = await gemini.chatWithImage({
        prompt: ESTIMATE_FOOD_PROMPT, // "Identify this food and estimate nutrition"
        imageBase64: base64,
        mimeType: 'image/jpeg',
        jsonMode: true,
      });
      const foodNutrition = JSON.parse(foodResponse.content || '{}');
      return showConfirmation(ctx, foodNutrition, 'food_photo');

    default:
      return ctx.reply("Couldn't identify this as a food photo, nutrition label, or barcode. Try again?");
  }
}

// ─── Confirmation Flow (shared by all inputs) ───
async function showConfirmation(ctx: Context, nutrition: NutritionData, source: string) {
  const chatId = String(ctx.chat!.id);

  pendingLogs.set(chatId, {
    chatId,
    nutrition,
    source: source as any,
    createdAt: Date.now(),
  });

  const msg = formatNutritionSummary(nutrition, source);

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Log it', callback_data: 'food_confirm' },
          { text: '❌ Cancel', callback_data: 'food_cancel' },
        ],
        [
          { text: '🍳 Breakfast', callback_data: 'meal_1' },
          { text: '🥗 Lunch', callback_data: 'meal_3' },
          { text: '🍽 Dinner', callback_data: 'meal_5' },
          { text: '🍿 Snack', callback_data: 'meal_7' },
        ]
      ]
    }
  });
}

function formatNutritionSummary(n: NutritionData, source: string): string {
  const sourceLabel = {
    text: '💬', barcode: '🔢', label_photo: '🏷️', food_photo: '📸'
  }[source] || '📝';

  return `${sourceLabel} <b>${n.foodName}</b>${n.brand ? ` (${n.brand})` : ''}\n\n` +
    `🔥 ${n.calories} cal\n` +
    `🥩 ${n.protein || 0}g protein\n` +
    `🍞 ${n.carbs || 0}g carbs\n` +
    `🧈 ${n.fat || 0}g fat\n` +
    `${n.servingSize ? `\n📏 Serving: ${n.servingSize}` : ''}\n\n` +
    `Tap a meal type, or ✅ to log as Anytime:`;
}

// ─── Callback Handler ───
async function handleCallback(ctx: Context) {
  const chatId = String(ctx.chat!.id);
  const data = ctx.callbackQuery!.data!;
  const pending = pendingLogs.get(chatId);

  if (!pending) {
    return ctx.answerCallbackQuery({ text: 'No pending food log.' });
  }

  if (data === 'food_cancel') {
    pendingLogs.delete(chatId);
    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
    return ctx.editMessageText('❌ Cancelled.');
  }

  // Meal type selection OR confirm
  let mealType = 'Anytime';
  if (data === 'meal_1') mealType = 'Breakfast';
  else if (data === 'meal_3') mealType = 'Lunch';
  else if (data === 'meal_5') mealType = 'Dinner';
  else if (data === 'meal_7') mealType = 'Anytime'; // Snack maps to Anytime for Fitbit

  // Log to Fitbit
  const result = await fitbitLogFoodTool.execute({
    foodName: pending.nutrition.foodName,
    calories: pending.nutrition.calories,
    protein: pending.nutrition.protein,
    carbs: pending.nutrition.carbs,
    fat: pending.nutrition.fat,
    mealType,
  }, getExecutionContext());

  pendingLogs.delete(chatId);

  if (result.success) {
    await ctx.answerCallbackQuery({ text: '✅ Logged!' });
    return ctx.editMessageText(result.output);
  } else {
    await ctx.answerCallbackQuery({ text: '❌ Failed' });
    return ctx.editMessageText(`❌ ${result.output}`);
  }
}
```

#### C.3 — System Prompts for Gemini

```typescript
// packages/core/src/prompts/food-logging.ts

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
```

### Phase D — Integration + Testing (2-3h)

#### D.1 — Fitbit Developer Setup (One-Time)

1. Go to https://dev.fitbit.com/apps/new
2. Register a **Personal** application (only needs to work for your account)
3. Settings:
   - **OAuth 2.0 Application Type:** Personal
   - **Callback URL:** `http://localhost:3000/api/fitbit/callback` (for initial auth)
   - **Default Access Type:** Read & Write
   - **Scopes:** Nutrition (only what we need)
4. Save Client ID and Client Secret to `.env`

#### D.2 — Initial Auth Flow

Add a temporary Fastify route for the OAuth callback:

```typescript
// packages/api/src/routes/fitbit-callback.ts
fastify.get('/api/fitbit/callback', async (req, reply) => {
  const code = (req.query as any).code;
  await fitbitAuth.exchangeCode(code);
  reply.send('✅ Fitbit connected! You can close this tab.');
});
```

Then in Telegram, `/fitbit_auth` sends you the authorization URL. Click it, authorize, tokens are saved. This only happens once — refresh tokens handle everything after.

#### D.3 — End-to-End Test Script

```typescript
// scripts/test-food-log.ts
// Run: npx tsx scripts/test-food-log.ts

async function test() {
  const gemini = new GeminiProvider(process.env.GEMINI_API_KEY!);
  
  // Test 1: Text parsing
  console.log('--- Text Parse ---');
  const textResult = await gemini.chat({
    systemInstruction: FOOD_PARSE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: '2 scrambled eggs with toast and butter' }],
  });
  console.log(textResult.content);

  // Test 2: Barcode lookup
  console.log('--- Barcode ---');
  const barcodeResult = await barcodeLookupTool.execute({ barcode: '7622210449283' }); // Oreo
  console.log(barcodeResult.output);

  // Test 3: Fitbit log (dry run — log to console, don't actually POST)
  console.log('--- Fitbit Log (dry) ---');
  console.log('Would log:', { foodName: 'Scrambled Eggs + Toast', calories: 380 });
}

test();
```

---

## 5. Shared Types

```typescript
// packages/tools/src/nutrition/types.ts

export interface NutritionData {
  foodName: string;
  brand?: string;
  servingSize?: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  mealType?: 'Breakfast' | 'Morning Snack' | 'Lunch' | 'Afternoon Snack' | 'Dinner' | 'Anytime';
  confidence?: 'high' | 'medium' | 'low';
  items?: string[];  // For food photo: breakdown of identified items
  notes?: string;
}
```

---

## 6. Environment Variables

```bash
# .env.example (add to your existing CherryAgent .env)

# Gemini
GEMINI_API_KEY=your_google_ai_api_key

# Fitbit
FITBIT_CLIENT_ID=your_fitbit_client_id
FITBIT_CLIENT_SECRET=your_fitbit_client_secret
FITBIT_REDIRECT_URI=http://localhost:3000/api/fitbit/callback

# Telegram (from your CherryAgent design)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_AUTHORIZED_CHAT_ID=your_chat_id
```

---

## 7. How It Connects to Full CherryAgent Later

This first build deliberately cuts corners that your design doc already solves. Here's the migration path:

| What we skip now | What your design has | When to add |
|------------------|---------------------|-------------|
| Hardcoded Gemini | Cost router + multi-provider | When you add a second workflow |
| In-memory pending logs | PostgreSQL `tasks` table + BullMQ | When you need persistence/queuing |
| No memory system | Memory retrieval + post-task learning | When "log my usual breakfast" should work |
| No approval gates | Approval queue + inline keyboards | Already have inline keyboards — gate is just a DB flag |
| No cost tracking | `cost_log` table + spend dashboard | When you care about budget monitoring |
| No skill system | Skill `.md` files + matcher | Food logging BECOMES a skill once the core is built |
| Direct tool calls | Tool framework + permissions | When you add filesystem/shell tools |
| grammy polling | Webhook mode on VPS | When you deploy (M6) |

The key insight: **every interface we define now matches your design doc exactly.** `LLMProvider`, `Tool`, `ToolResult`, `NutritionData` — these all slot into the full architecture without refactoring.

---

## 8. Estimated Cost Per Food Log

| Step | Tokens (est.) | Model | Cost |
|------|--------------|-------|------|
| Text parse | ~200 in, ~100 out | Gemini Flash (no thinking) | ~$0.00009 |
| Image classify | ~300 in, ~50 out | Gemini Flash (no thinking) | ~$0.00008 |
| Label/food extraction | ~400 in, ~150 out | Gemini Flash (no thinking) | ~$0.00015 |
| Barcode lookup | — | OpenFoodFacts (free) | $0.00 |
| Fitbit API call | — | REST API (free) | $0.00 |
| **Total per log** | | | **< $0.001** |

At 10 food logs/day, that's about **$0.30/month** — well within your $5 AI budget, leaving room for all your other workflows.

---

## 9. Future Enhancements (After Core Works)

- **"Log my usual breakfast"** — Memory system learns frequent meals, one-tap logging
- **Quick-log shortcuts** — `/log coffee` without confirmation for known items
- **Daily summary** — Scheduled task: "You've logged 1,450 cal today, 550 remaining"
- **Water tracking** — Same pattern: `fitbit.logWater` tool
- **Weight logging** — Morning prompt: "Weight today?" → `fitbit.logWeight`
- **Nutritionix API** — Fallback for barcodes not in OpenFoodFacts (requires API key, free tier available)
- **Quantity adjustment** — "Make that 2 servings" after confirmation
- **Batch scan** — Multiple barcode photos in sequence, confirm all at once

---

## 10. Build Order Summary

```
Day 1 (3-4h):
  ✅ Repo scaffold (packages/core, tools, api)
  ✅ Docker Compose (Postgres + Redis)  
  ✅ Gemini provider + test script
  ✅ Barcode lookup tool + test

Day 2 (4-5h):
  ✅ Fitbit OAuth2 setup + auth flow
  ✅ Fitbit food log tool
  ✅ Food parse prompts + test with Gemini
  ✅ End-to-end test: text → parse → Fitbit

Day 3 (4-5h):
  ✅ Grammy bot + handlers
  ✅ Photo flow (classify → extract → confirm)
  ✅ Inline keyboard confirm/meal-type flow
  ✅ Full Telegram → Gemini → Fitbit loop working

Total: ~12-14 hours to a working food logger via Telegram.
```

After this, you have a working agent core + Telegram bot + one real workflow. Every subsequent workflow (YouTube, CI monitor, briefing) adds tools and skills on top of the same foundation.
