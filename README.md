# CherryAgent

Self-hosted AI agent with configurable system access, designed to run on a budget VPS (~$10/month for AI + infrastructure). Built for a single user as a personal automation platform controlled via Telegram.

## Architecture

pnpm monorepo with three workspace packages:

```
packages/
  core/     # Agent loop, LLM provider interface, prompts
  tools/    # Tool interface, registry, implementations (Fitbit, barcode, etc.)
  api/      # Fastify server, Telegram bot, routes
```

**Stack:** TypeScript, Node.js 20+, Fastify, grammy (Telegram), PostgreSQL 16 + Drizzle ORM, Redis 7, BullMQ, Docker Compose.

**AI:** Tiered model routing to stay under budget — Groq (free) → DeepSeek → Gemini 2.5 Flash → Claude. The food logger uses Gemini 2.5 Flash with native vision, JSON mode, and tool calling.

## Prerequisites

- Node.js 20+
- pnpm 10+
- Docker & Docker Compose (for Postgres and Redis)

## Setup

1. **Clone and install:**

```sh
git clone <repo-url> && cd cherryagent
pnpm install
```

2. **Configure environment:**

```sh
cp .env.example .env
```

Fill in at minimum:

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | [Google AI Studio](https://aistudio.google.com) |
| `TELEGRAM_BOT_TOKEN` | Yes | Get from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Yes | Your chat ID (get from [@userinfobot](https://t.me/userinfobot)) |
| `FITBIT_CLIENT_ID` | Yes | [Fitbit developer app](https://dev.fitbit.com/apps) |
| `FITBIT_CLIENT_SECRET` | Yes | Same as above |
| `USER_TIMEZONE` | No | IANA timezone (default: `America/Toronto`) |

3. **Start infrastructure:**

```sh
docker compose -f docker-compose.dev.yml up -d
```

This starts PostgreSQL (`localhost:5432`) and Redis (`localhost:6379`).

4. **Authorize Fitbit:**

Run the OAuth2 flow to get your initial tokens:

```sh
pnpm tsx scripts/fitbit-auth.ts
```

Follow the browser prompt to authorize, then the callback at `http://localhost:3000/api/fitbit/callback` stores your tokens.

5. **Start the dev server:**

```sh
pnpm dev
```

Starts the Fastify server with tsx watch mode. The Telegram bot connects via long polling in development and webhooks in production.

## Development

```sh
pnpm dev              # Start API server (tsx watch)
pnpm -r typecheck     # Type-check all packages
pnpm -r build         # Build all packages
```

## Current Workflows

### Food Logger (Telegram → Fitbit)

Log food intake through Telegram and sync to Fitbit's Food Log API. Four input methods:

- **Text** — Natural language, e.g. "2 eggs and toast for breakfast"
- **Barcode** — Send a number (8-13 digits) or photo of a barcode; looked up via OpenFoodFacts
- **Nutrition label photo** — Gemini extracts macros directly from the label
- **Food photo** — Gemini estimates nutrition from a photo of the meal

The bot parses the input, shows a confirmation with calories and macros, and lets you pick a meal type before logging to Fitbit.

## Design Docs

Detailed specs live in `.claude/docs/`:

- `CherryAgent-Technical-Design-v1.md` — Full architecture, cost model, trigger system
- `CherryAgent-FoodLogger-Spec.md` — Food logger workflow spec and phased build plan
- `CherryAgent-Memory-System.md` — Memory layers, retrieval, lifecycle management
