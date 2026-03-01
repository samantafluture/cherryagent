# CherryAgent — Technical Design Document

**Version:** 1.0  
**Author:** Sam  

---

## 1. Executive Summary

CherryAgent is an always-on, self-hosted AI agent with configurable system access, designed to run autonomously on a Hostinger VPS. It operates as a persistent loop — observing triggers, reasoning about tasks, executing actions through sandboxed tools, and persisting state across sessions.

**Core principles:**
- Cost-first: $10/month total budget target (AI + infrastructure)
- Self-hosted: Docker on existing Hostinger VPS
- Provider-agnostic: Hot-swappable AI backends with tiered cost routing
- Secure by default: Granular permissions, approval gates, sandboxed execution

---

## 2. AI Provider Strategy (Cost Analysis)

### 2.1 Provider Tier Map

The agent uses a **tiered model routing** system. Every task is classified by complexity, and the cheapest capable model handles it.

| Tier | Provider | Model | Input $/1M | Output $/1M | Use Case | Free Tier? |
|------|----------|-------|-----------|------------|----------|------------|
| 0 (Free) | Google | Gemini 2.5 Flash-Lite | $0.10 | $0.40 | Routing, classification, simple extraction | ✅ ~1500 RPD |
| 0 (Free) | Groq | Llama 3.1 8B Instant | $0.05 | $0.08 | Fast classification, intent detection | ✅ Rate-limited |
| 1 (Cheap) | Groq | Qwen3 32B | $0.29 | $0.59 | Tool calling, structured output, planning | ✅ Rate-limited |
| 1 (Cheap) | DeepSeek | V3.1 | $0.15 | $0.75 | General reasoning, code gen, analysis | ❌ (pay-as-you-go) |
| 1 (Cheap) | Groq | Llama 3.3 70B | $0.59 | $0.79 | Complex tool use, multi-step reasoning | ✅ Rate-limited |
| 2 (Smart) | DeepSeek | V3.2 | $0.27 | $1.10 | Complex analysis, long-context tasks | ❌ |
| 2 (Smart) | Google | Gemini 2.5 Flash | $0.30 | $2.50 | Multimodal, grounded search, fallback | ✅ Limited |
| 3 (Premium) | Anthropic | Claude Haiku | ~$0.80 | ~$4.00 | Last-resort complex reasoning | ❌ |
| 3 (Premium) | Anthropic | Claude Sonnet | ~$3.00 | ~$15.00 | Emergency escalation only | ❌ |

### 2.2 Cost Routing Logic

```
Task arrives → Complexity classifier (Tier 0 model, free) → routes to:

  SIMPLE (classification, extraction, yes/no, routing)
    → Gemini Flash-Lite or Groq Llama 8B (FREE)
    
  MEDIUM (tool calling, structured output, summaries)
    → Groq Qwen3 32B or Llama 3.3 70B (FREE with rate limits)
    → Fallback: DeepSeek V3.1 ($0.15/$0.75)
    
  COMPLEX (multi-step reasoning, code generation, long context)
    → DeepSeek V3.2 ($0.27/$1.10)
    → Fallback: Gemini 2.5 Flash ($0.30/$2.50)
    
  CRITICAL (requires highest accuracy, safety-sensitive)
    → Claude Haiku ($0.80/$4.00) — budget-gated
    → Claude Sonnet — manual approval required
```

### 2.3 Monthly Cost Estimate

Assuming ~50 agent runs/day, averaging 3 tool-call loops each:

| Component | Tokens/day (est.) | Provider | Monthly Cost |
|-----------|-------------------|----------|-------------|
| Router/classifier | ~100K input, ~10K output | Gemini Flash-Lite (free) | $0.00 |
| Medium tasks (70%) | ~500K input, ~200K output | Groq free tier | $0.00 |
| Complex tasks (25%) | ~300K input, ~150K output | DeepSeek V3.1 | ~$1.80 |
| Critical tasks (5%) | ~50K input, ~30K output | Claude Haiku | ~$0.16 |
| **Total** | | | **~$2.00/mo** |

Buffer for spikes and retries: **~$5.00/mo max AI spend.**

### 2.4 Cost Control Mechanisms

1. **Hard budget cap**: Daily and monthly spend limits in USD. Agent stops escalating to paid tiers when budget is exhausted and falls back to free tier only.
2. **Token budget per task**: Each task gets a max token envelope. If exceeded, task is paused and queued for human review.
3. **Complexity downgrades**: If a Tier 2+ task fails, it does NOT auto-retry at higher tier. It queues for review.
4. **Caching layer**: Cache frequent prompts and responses (tool descriptions, system prompts, recurring queries) in Redis to avoid redundant API calls.
5. **Prompt compression**: Strip unnecessary context. Use summary-of-history instead of full conversation replay for long-running tasks.
6. **Spend dashboard**: Real-time tracking of spend per provider, per task type, per day.

---

## 3. Layer 1 — The Brain (Agent Loop)

### 3.1 Core Loop Architecture

The agent loop is a simple `while` loop that iterates until the task is complete or a limit is hit.

```
┌─────────────────────────────────────────────────┐
│                  AGENT LOOP                      │
│                                                  │
│  1. Receive task + context                       │
│  2. Select model (cost router)                   │
│  3. Send prompt + available tools to LLM         │
│  4. LLM responds with:                           │
│     a) tool_call → Execute tool → loop back to 3 │
│     b) text response → Task complete             │
│     c) ask_human → Pause, notify, wait           │
│  5. Persist result + update state                │
│  6. Check: max iterations? budget exceeded?      │
│     → If yes: pause + notify                     │
│     → If no: continue loop                       │
│                                                  │
└─────────────────────────────────────────────────┘
```

### 3.2 Loop Configuration

```typescript
interface AgentLoopConfig {
  maxIterations: number;        // Default: 15
  maxTokenBudget: number;       // Per-task token ceiling
  maxWallTime: number;          // Timeout in seconds (default: 300)
  model: ModelConfig;           // Selected by cost router
  tools: ToolDefinition[];      // Available tools for this task
  approvalRequired: string[];   // Tool names requiring human approval
  onPause: 'queue' | 'notify' | 'discard';
}
```

### 3.2.1 Human Interaction Primitives

The agent loop supports two distinct ways to pause for human input:

**Approval Gate** — "Can I do this?" (security check)
- Binary: Approve / Reject
- Used when a tool has `requiresApproval: true`
- Agent already decided what to do, needs permission

**Ask User** — "Which option should I pick?" (task input)
- Multiple choice: Pick one of [A, B, C, D] or free-text response
- Used when the agent needs a decision to continue the task
- Agent presents options, human drives the direction

```typescript
interface AskUserAction {
  type: 'ask_user';
  question: string;
  options: {
    label: string;           // Shown on Telegram button
    value: string;           // Returned to agent loop
    callbackData: string;    // Telegram callback ID
  }[];
  allowFreeText: boolean;    // Accept typed response too
  timeout: number;           // Auto-cancel after N minutes
  defaultValue?: string;     // If timeout, use this
}
```

Both primitives pause the agent loop, send a Telegram message with inline keyboards, and resume when the human responds. The difference is semantic: approval gates protect dangerous actions, ask_user drives task logic.

### 3.3 Unified Provider Interface

All AI providers are accessed through a single abstraction that normalizes tool calling across OpenAI-compatible and Google APIs.

```typescript
interface LLMProvider {
  id: string;                   // e.g. "groq-qwen3-32b"
  tier: 0 | 1 | 2 | 3;
  inputCostPer1M: number;
  outputCostPer1M: number;
  maxContextTokens: number;
  supportsToolCalling: boolean;
  
  chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<LLMResponse>;
}

interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[] | null;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}
```

**Implementation note**: Groq, DeepSeek, and OpenAI all use the OpenAI-compatible chat completions format. Google Gemini uses its own SDK but can be wrapped to the same interface. This means ~90% of providers share the same HTTP adapter.

### 3.4 Memory & Context Management

The agent has no persistent brain between tasks. Each task starts a fresh LLM conversation. "Memory" means: **what gets injected into the system prompt before the LLM starts thinking.**

#### Three Memory Layers

| Layer | Storage | TTL | Purpose |
|-------|---------|-----|---------|
| **Working Memory** | In-process array | Per-task | Current task's message history + tool results |
| **Short-term Memory** | PostgreSQL (`tasks`) | 30 days | Recent task outcomes, summaries, tools used |
| **Long-term Memory** | PostgreSQL (`agent_memory`) | Indefinite | Learned facts, preferences, patterns, entities |

#### System Prompt Assembly (per task)

```
Context budget: ~8,000 tokens for memories + history

1. Identity + Rules               (~800 tokens, fixed)
2. Available Tools                (~1,500 tokens, fixed)
3. Task Context                   (~500 tokens, variable)
4. Retrieved Memories             (~2,000 tokens, 20-30 most relevant)
5. Recent Task History            (~1,000 tokens, last 3-5 tasks summarized)
6. Working Conversation           (~2,200 tokens, grows during task)
```

#### Memory Retrieval (Simple, No Embeddings)

When a task starts, the agent pulls relevant memories:
1. **Project memories** — all active memories tagged to this project (by `access_count`)
2. **Recent task history** — last 5 completed/failed tasks for this project
3. **Global preferences** — always included regardless of task
4. **Keyword search** — memories matching task description (PostgreSQL ILIKE + GIN indexes)

This is fast, cheap, and 95% as good as embeddings at <1,000 memories. See memory system doc for full retrieval logic.

#### Post-Task Learning

After every task, a Tier 0 LLM (free) extracts new facts:
- Compares against existing memories for the project (avoids duplicates)
- Stores novel facts with category, project tag, confidence score
- Supersedes outdated memories (old → `superseded`, new replaces it)
- **Cost: ~$0.001 per extraction** (tiny input/output, free model)

#### Memory Categories

| Category | Example | Retrieval |
|----------|---------|-----------|
| `project` | "FinCherry parsers are in src/parsers/" | When task involves that project |
| `preference` | "Sam prefers terse Telegram messages" | Always injected |
| `pattern` | "CI ENOENT errors → check recent directory renames" | Keyword match |
| `entity` | "Sam's Nubank account is acc_1 in FinCherry" | When entity mentioned |

#### Memory Lifecycle
- **Creation**: Auto-extracted after tasks (confidence > 0.7)
- **Updates**: New facts supersede contradicting old ones (both tracked)
- **Decay**: Memories never accessed in 60 days → auto-archived
- **Manual**: Sam can list/add/delete memories via Telegram (`/memory`)

#### Working Memory Compression
To avoid ballooning context (and cost), the agent uses a **sliding window with summarization**: after every 5 tool-call iterations, the history is compressed into a summary by a Tier 0 model before continuing.

#### Why Not pgvector / Embeddings?
At <1,000 memories, keyword search + project filtering + GIN indexes cover 95% of retrieval needs. Memories are structured (category, project, tags) not unstructured documents. pgvector is a PostgreSQL extension — can be added later without changing databases if retrieval quality degrades.

### 3.5 Skills & Extensibility

The agent's capabilities expand through **three levels**, from no-code to code:

#### Level 1: Skills (Markdown Files — No Code)
A skill is a `.md` file with YAML frontmatter that teaches the agent how to handle a specific workflow using existing tools. Stored in `~/.cherryagent/skills/`.

```markdown
---
name: notion-sync
triggers:
  - cron: "30 8 * * *"
  - command: /notion sync
  - keyword: notion
project: null
tools_required: [http.fetch]
---
# Skill: Sync Notion Tasks
## What You Do
1. Query Notion API for open tasks...
2. Compare against agent memory...
3. Send summary to Telegram...
```

Skills are loaded into the system prompt based on trigger/keyword/project matching. Budget: ~3,000 tokens for skills per task (1-3 relevant skills).

**Skill sources:**
- `skills/builtin/` — Ships with CherryAgent (YouTube, CI monitor, briefing, task prep, FinCherry)
- `skills/custom/` — Created by Sam manually or via `/teach` command

#### Level 2: Plugins (TypeScript Modules — Code Required)
For capabilities that need custom logic beyond what `http.fetch` + skills can handle. A plugin registers new tools via `plugin.yaml` + TypeScript handlers.

```
~/.cherryagent/plugins/notion/
├── plugin.yaml          # Tool registration + credentials
└── tools/
    └── notion.query.ts  # Custom tool implementation
```

Plugins use a `ToolHandler` interface and get auto-injected `httpClient` with credential manager auth.

#### Level 3: Self-Expansion via `/teach`
The agent can create new skills from natural language instructions:

```
/teach Every day at noon, check top HN stories (100+ points) and send me a digest
→ Agent generates skill markdown, shows draft, Sam approves, skill saved + cron registered
```

The agent can self-create: skills, cron triggers, email filters, webhook handlers, memory entries.
The agent cannot self-create: plugins (code), system modifications, new dependencies.

#### System Prompt Assembly (Updated)

```
1. Identity + Rules                (~800 tokens, fixed)
2. Available Tools                 (~1,500 tokens, fixed)
3. Task Context + Trigger Info     (~500 tokens, variable)
4. Loaded Skills                   (~3,000 tokens, 1-3 relevant skills)
5. Retrieved Memories              (~2,000 tokens, 20-30 facts)
6. Recent Task History             (~1,000 tokens, last 3-5 tasks)
7. Working Conversation            (~2,200 tokens, sliding window)
```

---

## 4. Layer 2 — The Nervous System (Tool & Access Layer)

### 4.1 Tool Architecture

Tools are self-contained modules that follow a standard interface. Each tool declares what it does, what permissions it needs, and whether it requires human approval.

```typescript
interface Tool {
  name: string;                          // e.g. "fs.readFile"
  description: string;                   // Shown to LLM
  category: 'filesystem' | 'shell' | 'http' | 'database' | 'browser' | 'notification';
  parameters: JSONSchema;                // Input schema
  permissions: Permission[];             // Required permissions
  requiresApproval: boolean;             // Pause for human if true
  timeout: number;                       // Max execution time in ms
  
  execute(params: Record<string, any>, context: ExecutionContext): Promise<ToolResult>;
}

interface ToolResult {
  success: boolean;
  output: string;                        // Returned to LLM
  artifacts?: string[];                  // File paths, URLs, etc.
  sideEffects?: string[];                // What changed (for audit log)
}
```

### 4.2 Built-in Tool Categories

#### Filesystem Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `fs.readFile` | `fs:read:<path>` | No | Read file contents |
| `fs.writeFile` | `fs:write:<path>` | Configurable | Write/create file |
| `fs.listDir` | `fs:read:<path>` | No | List directory |
| `fs.deleteFile` | `fs:delete:<path>` | **Yes** | Delete a file |

#### Shell Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `shell.exec` | `shell:exec:<allowlist>` | Configurable | Run a shell command |
| `shell.execSandboxed` | `shell:sandbox` | No | Run in isolated container |

#### HTTP Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `http.fetch` | `http:fetch:<domain>` | No | GET/POST/PUT/DELETE to allowed domains (supports multipart file uploads) |
| `http.webhook` | `http:webhook` | No | Send to registered webhooks |

#### Credential Manager
The agent authenticates with external apps (FinCherry, GitHub, Etsy) without ever seeing raw credentials. Auth is injected automatically by domain.

```yaml
# agent-credentials.yaml (values from Docker secrets / .env)
credentials:
  fincherry.yourdomain.com:
    type: "email_password"
    loginUrl: "/api/auth/login"
    email: "${FINCHERRY_EMAIL}"
    password: "${FINCHERRY_PASSWORD}"
  api.github.com:
    type: "token"
    header: "Authorization: token ${GITHUB_TOKEN}"
  api.printful.com:
    type: "token"
    header: "Authorization: Bearer ${PRINTFUL_API_TOKEN}"
  # Phase 2 (Etsy/Surpride automation):
  # openapi.etsy.com:
  #   type: "oauth2"
  #   clientId: "${ETSY_CLIENT_ID}"
  #   ...
  # etsy.com:
  #   type: "browser_session"
  #   email: "${ETSY_EMAIL}"
  #   ...
```

The `http.fetch` tool auto-resolves credentials by domain. The LLM never sees tokens or passwords — it just calls `http.fetch` and auth is handled transparently.

#### Database Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `db.query` | `db:read:<schema>` | No | SELECT queries |
| `db.mutate` | `db:write:<schema>` | **Yes** | INSERT/UPDATE/DELETE |

#### Git Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `git.pull` | `shell:exec:git` | No | Pull latest changes for a tracked repo |
| `git.branch` | `shell:exec:git` | No | Create/switch branches |
| `git.commit` | `shell:exec:git` | No | Stage and commit changes |
| `git.push` | `shell:exec:git` | No | Push branch to origin |

#### GitHub API Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `github.getCI` | `http:fetch:api.github.com` | No | Check CI status for a repo/branch |
| `github.getCILogs` | `http:fetch:api.github.com` | No | Fetch logs from a failed CI run |
| `github.createPR` | `http:fetch:api.github.com` | No | Create PR (Sam always reviews before merge) |

#### Browser/Automation Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `browser.navigate` | `browser:nav:<domain>` | No | Open URL in headless browser |
| `browser.scrape` | `browser:scrape:<domain>` | No | Extract content from page |
| `browser.act` | `browser:act:<domain>` | **Yes** | Click, fill forms, interact |

#### Media Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `media.download` | `media:download` | No | Download video/audio via yt-dlp |
| `media.extractAudio` | `media:process` | No | Extract/convert audio via ffmpeg |
| `media.transcribe` | `media:transcribe` | No | Speech-to-text via Groq Whisper API |

#### Email Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `email.monitor` | `email:read` | No | Background IMAP polling — triggers tasks on matching emails |

#### Platform Tools — Phase 2 (Etsy/Surpride)
*Deferred until Sam's separate Etsy automation system is designed. The generic browser tools above cover the infrastructure; these add Etsy-specific logic.*

| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `etsy.sendMessage` | `browser:act:etsy.com` | Configurable | Send customer message via Etsy web UI |
| `etsy.getConversation` | `browser:scrape:etsy.com` | No | Read message history with customer |

#### Notification Tools
| Tool | Permission | Approval | Description |
|------|-----------|----------|-------------|
| `notify.telegram` | `notify:telegram` | No | Send Telegram message (primary channel) |
| `telegram.sendFile` | `notify:telegram` | No | Send file to Sam via Telegram |
| `notify.discord` | `notify:discord` | No | Send Discord webhook (secondary/log) |
| `notify.email` | `notify:email` | Configurable | Send email |

### 4.3 Permission System

Permissions use a hierarchical, path-based model:

```
<category>:<action>:<scope>

Examples:
  fs:read:/home/agent/projects/*     → Can read anything under projects/
  fs:write:/home/agent/projects/fincherry/*  → Can write to FinCherry only
  shell:exec:git,npm,docker          → Can only run git, npm, docker commands
  http:fetch:api.github.com,api.etsy.com  → Can only call these APIs
  db:read:fincherry.*                → Can read all FinCherry tables
  db:write:fincherry.tasks           → Can write only to the tasks table
```

Permissions are defined in a YAML config file:

```yaml
# agent-permissions.yaml
profiles:
  fincherry-dev:
    fs:
      read: ["/home/agent/projects/fincherry/**"]
      write: ["/home/agent/projects/fincherry/src/**"]
      delete: []  # never
    shell:
      exec: ["git", "npm", "pnpm", "node", "tsc"]
      sandbox: true
    http:
      fetch: ["api.github.com", "registry.npmjs.org"]
    db:
      read: ["fincherry.*"]
      write: ["fincherry.agent_tasks", "fincherry.agent_logs"]
    notifications:
      telegram: true    # Primary — approvals, alerts, task control
      discord: false    # Optional — read-only webhook log

  # Phase 2 — Etsy/Surpride automation profile (to be revised):
  # etsy-automation:
  #   http:
  #     fetch: ["openapi.etsy.com", "api.printful.com"]
  #   browser:
  #     nav: ["etsy.com", "printful.com"]
  #     scrape: ["etsy.com"]
  #     act: []
  #   notifications:
  #     telegram: true
```

### 4.4 Approval Gate System

When a tool with `requiresApproval: true` is called:

```
1. Agent pauses execution
2. Pending action is stored in PostgreSQL (approval_queue table)
3. Notification sent via Telegram Bot with inline keyboard buttons [✅ Approve] [❌ Reject]
4. Message includes: task context, tool name, parameters, expected side effects
5. Human taps button → Telegram callback query hits Fastify webhook endpoint
6. Agent resumes or aborts based on response
7. Timeout: If no response in N minutes, action is rejected (configurable)
```

**Configurable auto-approve**: For repetitive, low-risk actions, approval can be pre-authorized per workflow:

```yaml
auto_approve:
  # Phase 1 examples:
  media_cleanup: true              # Always auto-clean old media
  # Phase 2 (Etsy) — to be configured after Surpride automation is designed:
  # etsy_tracking_message: true
  # etsy_review_request: true
  # etsy_thank_you: false
  # etsy_customer_reply: false
```

---

## 5. Layer 3 — The Body (Runtime & Persistence)

### 5.1 System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     HOSTINGER VPS (Docker)                    │
│                                                              │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Fastify API      │  │  Agent Worker │  │  Cron         │   │
│  │  - Dashboard      │  │  (Loop Runner)│  │  Scheduler    │   │
│  │  - Webhooks       │  │              │  │              │   │
│  │  - Telegram Bot   │  │              │  │              │   │
│  │    (webhook mode) │  │              │  │              │   │
│  └──────┬───────────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                     │                  │           │
│         ▼                     ▼                  ▼           │
│  ┌────────────────────────────────────────────────────┐      │
│  │                    BullMQ (Redis)                   │      │
│  │              Task Queue + Job Scheduling            │      │
│  └────────────────────────┬───────────────────────────┘      │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────┐      │
│  │                   PostgreSQL                        │      │
│  │  - Tasks, Results, Approval Queue                   │      │
│  │  - Agent State, Memory, Audit Log                   │      │
│  │  - Cost Tracking, Provider Stats                    │      │
│  └────────────────────────────────────────────────────┘      │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────────────┐      │
│  │    Redis                   
│  │      │  │  (Cache + Queue backing)     │      │
│  │           │  │                              │      │
│  └──────────────────┘  └──────────────────────────────┘      │
│                                                              │
└──────────────────────────────────────────────────────────────┘

External:
  Telegram Bot API ←→ Fastify /api/telegram/webhook (inline keyboards for approvals)
```

### 5.2 Service Components

| Service | Tech | Role | Docker Container |
|---------|------|------|-----------------|
| **API Server** | Fastify + tRPC | Dashboard, webhooks, Telegram bot webhook, manual triggers, approval UI | `cherry-agent-api` |
| **Telegram Bot** | Telegram Bot API (webhook mode) | Primary control plane — approvals, task triggers, status, cost queries | (inside `cherry-agent-api`) |
| **Agent Worker** | Node.js long-running process | Consumes tasks from queue, runs agent loop | `cherry-agent-worker` |
| **Scheduler** | node-cron inside worker | Fires scheduled/recurring tasks into queue | (same container) |
| **PostgreSQL** | PostgreSQL 16 | All persistent state | `cherry-agent-db` |
| **Redis** | Redis 7 | BullMQ backing store + prompt cache | `cherry-agent-redis` |

### 5.3 Database Schema (Core Tables)

```sql
-- Tasks
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,            -- 'manual', 'scheduled', 'webhook', 'chained'
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, running, paused, completed, failed
  priority INTEGER DEFAULT 0,
  
  -- Task definition
  prompt TEXT NOT NULL,
  project VARCHAR(50),                    -- Which project this relates to (for memory scoping)
  context JSONB DEFAULT '{}',             -- Additional context for the task
  tools TEXT[] DEFAULT '{}',              -- Allowed tool names for this task
  permission_profile VARCHAR(50),         -- References agent-permissions.yaml
  
  -- Execution config
  model_tier INTEGER DEFAULT 1,           -- Suggested starting tier
  max_iterations INTEGER DEFAULT 15,
  max_token_budget INTEGER DEFAULT 50000,
  
  -- Results
  result TEXT,
  summary TEXT,                           -- Brief summary for memory/history (auto-generated)
  outcome VARCHAR(20),                    -- 'success', 'partial', 'failed', 'cancelled'
  artifacts JSONB DEFAULT '[]',
  error TEXT,
  
  -- Memory context
  memories_used UUID[] DEFAULT '{}',      -- Which memories were injected for this task
  tools_used TEXT[] DEFAULT '{}',         -- Which tools were actually called
  iterations INTEGER DEFAULT 0,           -- How many agent loop iterations
  
  -- Cost tracking
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost_usd DECIMAL(10,6) DEFAULT 0,
  provider_breakdown JSONB DEFAULT '{}',
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  
  -- Scheduling
  schedule_cron VARCHAR(100),             -- For recurring tasks
  next_run_at TIMESTAMPTZ
);

CREATE INDEX idx_tasks_project ON tasks(project, completed_at DESC);
CREATE INDEX idx_tasks_status ON tasks(status);

-- Approval Queue
CREATE TABLE approval_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id),
  tool_name VARCHAR(100) NOT NULL,
  tool_params JSONB NOT NULL,
  context_summary TEXT,                  -- Why the agent wants to do this
  status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected, expired
  decided_at TIMESTAMPTZ,
  decision_by VARCHAR(50),              -- 'human', 'auto-timeout'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ                -- Auto-reject after this
);

-- Agent Memory (learned facts, patterns, preferences)
CREATE TABLE agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,                  -- The actual fact/knowledge
  category VARCHAR(30) NOT NULL,          -- 'project', 'preference', 'pattern', 'entity'
  project VARCHAR(50),                    -- NULL = global, 'fincherry', 'arche-signal', etc.
  tags TEXT[] DEFAULT '{}',               -- Searchable keywords: ['parser', 'pdf', 'itau']
  source_task_id UUID REFERENCES tasks(id),
  confidence DECIMAL(3,2) DEFAULT 0.8,    -- 0-1, how confident
  status VARCHAR(20) DEFAULT 'active',    -- 'active', 'superseded', 'archived'
  superseded_by UUID REFERENCES agent_memory(id),
  access_count INTEGER DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memory_project ON agent_memory(project) WHERE status = 'active';
CREATE INDEX idx_memory_category ON agent_memory(category) WHERE status = 'active';
CREATE INDEX idx_memory_tags ON agent_memory USING GIN(tags) WHERE status = 'active';
CREATE INDEX idx_memory_content_search ON agent_memory 
  USING GIN(to_tsvector('english', content)) WHERE status = 'active';

-- Memory Changelog (track how memories evolve)
CREATE TABLE memory_changelog (
  id SERIAL PRIMARY KEY,
  memory_id UUID REFERENCES agent_memory(id),
  action VARCHAR(20) NOT NULL,            -- 'created', 'updated', 'superseded', 'archived'
  old_content TEXT,
  new_content TEXT,
  reason TEXT,
  task_id UUID REFERENCES tasks(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cost Tracking
CREATE TABLE cost_log (
  id SERIAL PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  provider VARCHAR(50) NOT NULL,
  model VARCHAR(100) NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd DECIMAL(10,6) NOT NULL,
  cached BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit Log
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  task_id UUID REFERENCES tasks(id),
  action VARCHAR(50) NOT NULL,          -- 'tool_executed', 'approval_requested', 'model_called'
  tool_name VARCHAR(100),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- User Prompts (ask_user interactions)
CREATE TABLE user_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id),
  question TEXT NOT NULL,
  options JSONB NOT NULL,                -- [{ label, value, callbackData }]
  allow_free_text BOOLEAN DEFAULT FALSE,
  response_value TEXT,                   -- User's chosen value
  status VARCHAR(20) DEFAULT 'pending', -- pending, answered, expired
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
```

### 5.4 Trigger System

Tasks enter the queue via multiple trigger types:

| Trigger | Source | Example |
|---------|--------|---------|
| **Manual** | Dashboard UI or Telegram command | "Deploy FinCherry to staging" |
| **Scheduled** | Cron expression in task definition | "Run daily health check at 9am" |
| **Webhook** | HTTP POST to `/api/webhook/:id` | GitHub CI failure, Printful events (Phase 2) |
| **Chained** | Previous task completion | "After deploy succeeds, run smoke tests" |
| **Watched** | File watcher or polling | "When new bank statement PDF appears, parse it" |
| **Delayed** | Relative to another event | "7 days after event X, run task Y" |

### 5.5 Media Storage & Retention

Downloaded media (videos, audio) are transient — they exist to be delivered via Telegram, not stored long-term.

```yaml
# agent-config.yaml → media section
media:
  base_path: "${MEDIA_DIR}"          # /opt/cherry-agent/media on VPS, ./media locally
  video_retention_hours: 24          # Delete video after 24h (already sent via Telegram)
  audio_retention_hours: 48          # Slightly longer for audio (might not listen same day)
  notes_retention_days: 30           # Keep generated notes longer (text is tiny)
  max_storage_gb: 5                  # Hard cap — oldest files deleted first when exceeded
  video_max_height: 720              # Don't download 1080p/4K
  audio_bitrate: "128k"             
  cleanup_cron: "0 */6 * * *"       # Cleanup every 6 hours
```

With 24h video retention: typically <500MB stored at any time.

### 5.6 Dashboard (Minimal UI)

A lightweight React dashboard (served by the Fastify API) providing:

- **Task list**: Active, queued, completed tasks with status
- **Live view**: Current agent iteration, tool calls, LLM responses in real-time
- **Approval panel**: Pending approval requests with approve/reject buttons
- **Cost dashboard**: Daily/monthly spend by provider, projected burn rate
- **Config editor**: Edit permission profiles, tool configurations
- **Manual trigger**: Submit new tasks with prompt + config

The dashboard is intentionally simple — most interaction happens via Telegram bot (approvals, task triggers, status checks). The dashboard exists for cost monitoring and bulk configuration.

---

## 6. Development & Deployment Workflow

### 6.1 Local-First Development

Everything runs locally via Docker Compose before it ever touches the VPS. One command to start:

```bash
git clone git@github.com:sam/cherryagent.git
cd cherry-agent
cp .env.example .env          # Add API keys (Groq, DeepSeek, Telegram bot token)
pnpm install
docker compose -f docker-compose.dev.yml up
```

This spins up all services locally:

| Service | Local Port | Notes |
|---------|-----------|-------|
| Fastify API + Dashboard | `localhost:3000` | Hot-reload via tsx watch |
| Telegram Bot | `localhost:3000/api/telegram` | Uses polling mode locally (no webhook needed) |
| PostgreSQL | `localhost:5432` | Seeded with dev schema via Drizzle migrations |
| Redis | `localhost:6379` | Ephemeral, no persistence needed locally |
| BullMQ Dashboard | `localhost:3000/admin/queues` | Built-in Bull Board UI for queue inspection |

**Key local-vs-prod differences:**

| Concern | Local | Production (VPS) |
|---------|-------|-------------------|
| Telegram Bot mode | **Long polling** (no public URL needed) | **Webhook** (Fastify receives POST) |
| Hot reload | tsx watch + Vite HMR | Built containers, PM2 restart |
| DB data | Seeded fixtures | Real persistent data |
| Cost controls | Dry-run mode (log API calls, don't send) | Real spend tracking |
| HTTPS | Not needed | Caddy or nginx reverse proxy |

### 6.2 Easy Setup Script

A single `setup.sh` script handles first-time setup:

```bash
#!/bin/bash
# cherry-agent/setup.sh

echo "🍒 CherryAgent Setup"

# 1. Check prerequisites
command -v docker >/dev/null || { echo "❌ Docker required"; exit 1; }
command -v pnpm >/dev/null || { echo "❌ pnpm required"; exit 1; }
command -v node >/dev/null || { echo "❌ Node.js 20+ required"; exit 1; }

# 2. WSL check — warn if running from /mnt/c (Windows filesystem)
if [[ "$(pwd)" == /mnt/c/* ]] || [[ "$(pwd)" == /mnt/d/* ]]; then
  echo "⚠️  WARNING: You're on the Windows filesystem. This will be very slow."
  echo "   Move the project to ~/projects/cherry-agent for best performance."
  read -p "   Continue anyway? (y/N) " -n 1 -r
  echo
  [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi

# 3. Copy env template
if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝 Created .env — fill in your API keys"
fi

# 4. Install dependencies
pnpm install

# 5. Start infrastructure
docker compose -f docker-compose.dev.yml up -d db redis

# 6. Wait for Postgres to be ready
echo "⏳ Waiting for Postgres..."
until docker compose exec db pg_isready; do sleep 1; done

# 7. Run migrations
pnpm db:migrate

# 8. Seed dev data (optional)
pnpm db:seed

# 9. Start dev server
echo "🚀 Starting CherryAgent in dev mode..."
pnpm dev
```

### 6.3 .env.example

```bash
# === AI Providers (add only the ones you want) ===
GROQ_API_KEY=                    # Free tier — get from console.groq.com
DEEPSEEK_API_KEY=                # Pay-as-you-go — get from platform.deepseek.com
GEMINI_API_KEY=                  # Free tier — get from aistudio.google.com
ANTHROPIC_API_KEY=               # Premium fallback — get from console.anthropic.com

# === Telegram Bot ===
TELEGRAM_BOT_TOKEN=              # Get from @BotFather
TELEGRAM_CHAT_ID=                # Your personal chat ID (get from @userinfobot)

# === Database ===
DATABASE_URL=postgresql://agent:agent@localhost:5432/cherry_agent

# === Redis ===
REDIS_URL=redis://localhost:6379

# === Agent Config ===
AGENT_MAX_DAILY_SPEND_USD=0.50   # Hard daily cap
AGENT_MAX_MONTHLY_SPEND_USD=5.00 # Hard monthly cap
AGENT_DEFAULT_MODEL_TIER=1       # Default tier for new tasks
AGENT_DRY_RUN=false              # Set true to log API calls without sending

# === Environment ===
NODE_ENV=development
PORT=3000
```

### 6.4 GitHub Actions Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: agent
          POSTGRES_PASSWORD: agent
          POSTGRES_DB: cherry_agent_test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7
        ports: ['6379:6379']
    env:
      DATABASE_URL: postgresql://agent:agent@localhost:5432/cherry_agent_test
      REDIS_URL: redis://localhost:6379
      AGENT_DRY_RUN: true
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate
      - run: pnpm test

  build-docker:
    needs: [lint-and-typecheck, test]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: false              # Build only — push handled by deploy job
          tags: cherry-agent:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: [build-docker]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/cherry-agent
            git pull origin main
            docker compose -f docker-compose.prod.yml build
            docker compose -f docker-compose.prod.yml up -d --remove-orphans
            docker compose exec api pnpm db:migrate
            echo "✅ Deployed $(git rev-parse --short HEAD)"
```

### 6.5 Branch Strategy

```
main        → Production (auto-deploys to VPS)
develop     → Integration branch (CI runs, no deploy)
feature/*   → Feature branches (CI runs on PR)
```

### 6.6 Deployment Phases

| Phase | What | When |
|-------|------|------|
| **Phase 0** | Local dev only. Docker Compose, hot reload, dry-run mode. | Now → until core agent loop works |
| **Phase 1** | Local + real API keys. Agent runs real tasks locally. | After core loop + 2-3 tools working |
| **Phase 2** | CI pipeline active. Tests, lint, typecheck on every push. | After test suite exists |
| **Phase 3** | VPS deployment. `main` auto-deploys. Telegram webhook mode. | After local is stable for ~1 week |

---

## 7. Local vs. VPS Access Model

Understanding what the agent can and cannot access is critical, especially when moving from local development to a VPS.

### 7.1 Core Principle

**Local:** The agent runs on your laptop. It sees your WSL filesystem, your local ports, your local Docker containers. Your laptop must be on for the agent to work.

**VPS:** The agent runs on a remote server. It has zero access to your laptop. Your laptop can be off, asleep, or disconnected — the agent keeps running 24/7. It works with repos, APIs, files you send it, and its own storage.

### 7.2 What the Agent Accesses on VPS

```
VPS Filesystem (/opt/cherryagent/)
├── agent code + config
├── repos/                  ← cloned from GitHub (git pull to update)
│   ├── fincherry/
│   ├── surpride-app/
├── uploads/                ← files you send via Telegram or dashboard
├── media/                  ← downloaded/generated media (videos, audio, etc.)
├── data/                   ← PostgreSQL, Redis, agent state
└── outputs/                ← files the agent creates for you

External access:
  ✅ GitHub API (read repos, create PRs, check CI)
  ✅ Etsy/Printful APIs (store management)
  ✅ Any public API or website you allowlist
  ✅ Web scraping + downloads via Playwright / CLI tools
  ✅ Telegram file exchange (send/receive files with you)
  ❌ Your laptop filesystem
  ❌ Your local network
```

### 7.3 How You Exchange Files with the Agent

| Direction | Method | Size Limit | Use Case |
|-----------|--------|-----------|----------|
| **You → Agent** | Telegram file attachment | 20MB (standard), 2GB (local bot API) | Send PDFs, images, docs for processing |
| **You → Agent** | Dashboard upload | Unlimited (VPS disk) | Large files |
| **You → Agent** | Shared cloud folder (Google Drive, Syncthing) | Unlimited | Recurring file drops |
| **Agent → You** | Telegram file send | 50MB (standard), 2GB (local bot API) | Send processed results, media, reports |
| **Agent → You** | Dashboard download link | Unlimited | Large outputs |
| **Agent → You** | Cloud storage upload | Unlimited | Agent pushes to Google Drive / R2 / S3 |

### 7.4 Git Repos on VPS

The agent doesn't read your local code. It clones repos from GitHub. Workflow:

1. You push code to GitHub from your laptop
2. Agent runs `git pull` in its cloned copy on VPS
3. Agent reads/analyzes the up-to-date code
4. Agent can create branches, commits, PRs — you review on GitHub

This is actually better than local access: the agent always sees clean, committed code.

### 7.5 Environment-Aware Paths

Tool permissions adapt to the environment:

```yaml
# Paths resolve differently per environment
paths:
  repos: 
    local: "~/projects"
    vps: "/opt/cherryagent/repos"
  uploads:
    local: "./uploads"
    vps: "/opt/cherryagent/uploads"
  media:
    local: "./media"
    vps: "/opt/cherryagent/media"
  outputs:
    local: "./outputs"
    vps: "/opt/cherryagent/outputs"
```

---

## 8. Security Model

### 8.1 Isolation Layers

1. **Container isolation**: Agent worker runs in its own Docker container with limited host access
2. **Filesystem sandboxing**: Agent can only access mounted volumes (never host root)
3. **Network restrictions**: Outbound HTTP is limited to allowlisted domains via tool permissions
4. **Shell sandboxing**: Dangerous commands are blocked. Optional: run shell commands in a disposable Docker-in-Docker container
5. **Database isolation**: Agent uses a dedicated DB user with grants only on agent-specific tables
6. **Secret management**: API keys stored in Docker secrets or `.env`, never in task context or logs

### 8.2 Safety Rails

- **No recursive self-modification**: Agent cannot modify its own code, configs, or Docker setup
- **No credential access**: Agent never sees raw API keys; the provider adapter handles auth
- **Audit everything**: Every tool execution, every LLM call, every approval decision is logged
- **Kill switch**: Dashboard has a big red "STOP ALL" button that drains the queue and kills the worker

---

## 9. Tech Stack Summary

| Component | Technology | Justification |
|-----------|-----------|---------------|
| Language | TypeScript (Node.js) | Matches Sam's stack, async-first, rich ecosystem |
| API Framework | Fastify + tRPC | Already used in FinCherry, type-safe |
| Task Queue | BullMQ | Battle-tested, Redis-backed, retries, scheduling |
| Database | PostgreSQL 16 + Drizzle ORM | Already in use, reliable, pgvector for embeddings |
| Cache | Redis 7 | BullMQ requires it, also used for prompt caching |
| Container Runtime | Docker Compose | Already used on Hostinger VPS |
| Dashboard | React + Vite | Lightweight, same frontend stack |
| AI SDKs | OpenAI SDK (for Groq/DeepSeek), Google GenAI SDK | OpenAI-compatible covers 80% of providers |
| Telegram | Telegram Bot API (raw HTTP or grammy) | Lightweight, webhook mode, inline keyboards for approvals |
| Media Download | yt-dlp | YouTube/video downloads, actively maintained |
| Media Processing | ffmpeg | Audio extraction, format conversion, industry standard |
| Speech-to-Text | Groq Whisper Turbo API | $0.04/hour transcription — cheapest fast option |
| Notifications | Telegram Bot API (webhook mode) | Zero extra process — hooks into Fastify, two-way with inline keyboards |

---

## 10. What This Is NOT (Scope Boundaries)

- **Not a chatbot**: No real-time conversational UI. Tasks are fire-and-forget with results.
- **Not multi-tenant**: Single user (Sam) only.
- **Not a model trainer**: Uses pre-trained models via API only.
- **Not a general-purpose agent framework**: Purpose-built for Sam's workflows.
- **No GPU needed**: All inference is via remote APIs.

---

## 11. Open Questions

1. **Telegram bot setup**: Create via @BotFather. Need to decide: single chat (just Sam) or a group chat for potential future collaborators? Recommend: single chat to start.
2. **pgvector for semantic memory?** Decided: No for Phase 1. PostgreSQL ILIKE + GIN indexes + full-text search covers retrieval at <1,000 memories. pgvector is a PostgreSQL extension — add later if keyword retrieval quality degrades.
4. **DeepSeek reliability**: DeepSeek API has had outages. Need retry logic with fallback to Groq.
5. **Rate limit handling for Groq free tier**: Need graceful degradation when rate-limited (queue + retry with backoff, or fallback to paid provider).

---

## 12. Success Metrics

| Metric | Target |
|--------|--------|
| Monthly AI cost | < $5 |
| Monthly infrastructure cost | < $5 (within existing VPS) |
| Task completion rate | > 90% without human intervention |
| Avg task latency (simple) | < 10 seconds |
| Avg task latency (complex) | < 60 seconds |
| Uptime | > 99% (worker auto-restarts) |

---

