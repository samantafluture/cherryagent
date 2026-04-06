# CherryAgent

Self-hosted AI agent controlled via Telegram. Food logging (text/barcode/photo -> Fitbit sync), task management, personal automation. Budget VPS (~$10/mo) with cost-optimized LLM routing.

## Stack

TypeScript 5.9+ (strict), Node.js 20+, Fastify 5, PostgreSQL 16, Redis 7 + BullMQ, Drizzle ORM, grammy (Telegram), Gemini 2.5 Flash, pnpm workspaces.

## Structure

```
packages/
  api/src/
    index.ts              # Entry point
    routes/               # HTTP endpoints
    bot/                  # Telegram command handlers
  core/src/
    agent-loop.ts         # Main processing loop
    llm/                  # LLM providers, tiered routing
  tools/src/
    nutrition/            # Food logging (text, barcode, photo)
    fitbit/               # Fitbit API + OAuth
    tasks/                # Task management
    voice/                # Voice coding pipeline
    media/                # YouTube/media processing
scripts/                  # Utilities (fitbit-auth.ts, etc.)
.claude/docs/             # Design specs and architecture docs
```

## Commands

```bash
pnpm dev              # Start API server (tsx watch)
pnpm dev:worker       # Start agent loop (core)
pnpm build            # TypeScript build all packages
pnpm lint             # ESLint all packages
pnpm typecheck        # Type-check all packages
docker compose up -d  # Dev: PostgreSQL + Redis
```

## Key Patterns

- **Tiered LLM routing:** Groq (free) -> DeepSeek -> Gemini Flash -> Claude (expensive). Configurable via `AGENT_DEFAULT_MODEL_TIER`. Daily/monthly spend caps enforced.
- **Tool architecture:** Each tool implements a shared `Tool` interface, registered in central registry. Agent loop dispatches based on intent.
- **Food logging:** Four inputs (text, barcode, photo, voice) -> all sync to Fitbit API.

## Deploy

Docker multi-stage build (includes ffmpeg, python3, yt-dlp). Runs as non-root (node, UID 1000:1000). Prod: `docker compose -f docker-compose.prod.yml up -d`.

## Env

Required: `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `FITBIT_CLIENT_ID`, `FITBIT_CLIENT_SECRET`. See `.env.example`.

## Rules

- No `any` — use `unknown` and narrow
- No direct LLM calls outside `packages/core` — tools request via agent loop
- No `console.log` — use Fastify logger
- No spending without caps — respect daily/monthly limits
- Conventional commits. Run `pnpm lint && pnpm typecheck && pnpm build` before committing.
