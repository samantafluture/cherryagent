# CLAUDE.md — CherryAgent Architectural Fence

This file is the single source of truth for AI agents working on CherryAgent.
Read it completely before writing any code. Every rule here is a hard constraint,
not a suggestion.

---

## 1. What is CherryAgent?

CherryAgent is a self-hosted AI agent for personal automation, controlled via
Telegram. It handles food logging (text/barcode/photo → Fitbit sync), task
management, and personal automation workflows. Designed to run on a budget VPS
(~$10/month) with cost-optimized LLM routing.

**Design principles:** self-hosted, cost-conscious, Telegram-first, tool-driven
architecture, tiered LLM routing.

---

## 2. Technology Stack

| Layer        | Technology                              |
| ------------ | --------------------------------------- |
| Monorepo     | pnpm workspaces (`packages/*`)          |
| Language     | TypeScript 5.9+ (strict mode)           |
| Runtime      | Node.js 20+                             |
| Backend      | Fastify 5                               |
| Bot          | grammy 1.40 (Telegram)                  |
| AI           | @google/genai (Gemini 2.5 Flash)        |
| Database     | PostgreSQL 16                           |
| Queue        | Redis 7 + BullMQ                        |
| ORM          | Drizzle ORM (planned)                   |
| Linting      | ESLint (typescript-eslint)              |
| Formatting   | _(not configured)_                      |
| Testing      | _(not yet configured)_                  |

**Do NOT add** alternative bot frameworks, web UI frameworks, or any dependency
not listed above without explicit approval.

---

## 3. Project Structure

```
cherryagent/
├── packages/
│   ├── api/                    # Fastify server + Telegram bot
│   │   └── src/
│   │       ├── index.ts        # Entry point
│   │       ├── routes/         # HTTP endpoints
│   │       └── bot/            # Telegram command handlers
│   │
│   ├── core/                   # Agent loop + LLM interface
│   │   └── src/
│   │       ├── index.ts        # Agent loop entry
│   │       ├── agent-loop.ts   # Main processing loop
│   │       └── llm/            # LLM providers, tiered routing
│   │
│   └── tools/                  # Tool implementations
│       └── src/
│           ├── nutrition/      # Food logging (text, barcode, photo)
│           ├── fitbit/         # Fitbit API integration + OAuth
│           ├── tasks/          # Task management
│           ├── voice/          # Voice coding pipeline
│           ├── media/          # YouTube/media processing
│           └── inspiration/    # Inspiration board
│
├── scripts/                    # Utility scripts (fitbit-auth.ts, etc.)
├── nginx/                      # Production nginx config
├── .claude/docs/               # Design specs and architecture docs
├── docker-compose.yml          # Dev: PostgreSQL + Redis
├── docker-compose.prod.yml     # Production config
├── Dockerfile.prod             # Multi-stage build (includes ffmpeg, yt-dlp)
└── .env.example
```

**Where new code goes:**

- New Telegram command? → `packages/api/src/bot/`
- New HTTP route? → `packages/api/src/routes/`
- New tool/integration? → `packages/tools/src/toolname/`
- New LLM logic? → `packages/core/src/llm/`
- Agent loop changes? → `packages/core/src/agent-loop.ts`

---

## 4. Naming Conventions

| Thing        | Convention     | Example                                   |
| ------------ | -------------- | ----------------------------------------- |
| Files        | kebab-case     | `agent-loop.ts`, `barcode-lookup.ts`      |
| Classes      | PascalCase     | `AgentLoop`, `FitbitAuth`                 |
| Variables    | camelCase      | `chatId`, `modelTier`                     |
| Constants    | SCREAMING_CASE | `MAX_DAILY_SPEND_USD`                     |
| Test files   | Co-located     | `*.test.ts` next to source                |
| Barrel files | `index.ts`     | Each feature directory exports via barrel  |

---

## 5. Key Patterns

### Tiered LLM Routing
Cost optimization via model tiers (cheapest first):
- Tier 0: Groq (free tier)
- Tier 1: DeepSeek
- Tier 2: Gemini 2.5 Flash (default)
- Tier 3: Claude (expensive, reserved for complex tasks)

Configurable via `AGENT_DEFAULT_MODEL_TIER` env var. Daily/monthly spend caps enforced.

### Tool Architecture
- Each tool implements a shared `Tool` interface
- Tools registered in a central registry (`packages/tools/src/`)
- Agent loop dispatches to tools based on intent classification

### Food Logging Pipeline
Four input methods: text description, barcode scan, photo, voice
All routes end at Fitbit API for calorie/nutrition tracking.

### Docker Production
Multi-stage build includes: ffmpeg, python3, yt-dlp, git (for media processing).
Runs as non-root user (1001:1001). Mounts `~/.cherryagent` for token storage.

---

## 6. Commands Reference

```bash
# Development
pnpm install              # Install all dependencies
pnpm dev                  # Start API server (tsx watch)
pnpm dev:worker           # Start agent loop (core)

# Build
pnpm build                # TypeScript build all packages

# Quality
pnpm lint                 # ESLint all packages
pnpm typecheck            # Type-check all packages

# Docker (dev)
docker compose up -d      # Start PostgreSQL + Redis
docker compose down       # Stop services

# Docker (prod)
docker compose -f docker-compose.prod.yml up -d
```

---

## 7. Do NOT List

- **No `any`** — use `unknown` and narrow
- **No hardcoded API keys** — use `.env` (never commit `.env`)
- **No direct LLM calls outside core** — tools request LLM via the agent loop
- **No synchronous blocking** — all I/O is async
- **No `console.log`** — use Fastify logger
- **No spending without caps** — respect `AGENT_MAX_DAILY_SPEND_USD` and `AGENT_MAX_MONTHLY_SPEND_USD`
- **No tool that doesn't implement the Tool interface** — all tools go through the registry

---

## 8. Environment Variables

**Required:** `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `FITBIT_CLIENT_ID`, `FITBIT_CLIENT_SECRET`
**Optional:** `GROQ_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `USER_TIMEZONE`, `AGENT_MAX_DAILY_SPEND_USD`, `AGENT_MAX_MONTHLY_SPEND_USD`
See `.env.example` for full list.

---

## 9. Git & Workflow

- **Commits:** conventional commits (`feat:`, `fix:`, `chore:`, etc.)
- **Before committing:** `pnpm lint && pnpm typecheck && pnpm build`
- **Deploy:** Docker multi-stage build → VPS via SSH

---

## Task Management
Tasks: .claude/tasks.md
