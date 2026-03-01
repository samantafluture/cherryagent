# CherryAgent — Memory & Context System

## How the Agent "Remembers"

The agent doesn't have a persistent brain between tasks. Each task starts a fresh LLM conversation. So "memory" means: **what do we inject into the system prompt before the LLM starts thinking?**

The system prompt for every task looks like this:

```
┌─────────────────────────────────────────┐
│ SYSTEM PROMPT                            │
│                                          │
│ 1. Identity + Rules                      │
│    "You are CherryAgent, Sam's           │
│    personal automation agent..."         │
│                                          │
│ 2. Available Tools                       │
│    [list of tools + descriptions]        │
│                                          │
│ 3. Task Context                          │
│    "Task: prep next fincherry task"      │
│    "Triggered by: Telegram /prep"        │
│    "Repo: fincherry (main branch)"       │
│                                          │
│ 4. Relevant Memories  ← THIS IS THE KEY │
│    [retrieved from DB based on task]     │
│                                          │
│ 5. Recent History                        │
│    "Last 3 tasks on this repo:           │
│     - Fixed CI path issue (2h ago)       │
│     - Prepped itau-parser task (yesterday)│
│     - Morning briefing (today 8am)"      │
│                                          │
└─────────────────────────────────────────┘
```

Section 4 is where the magic happens. The agent retrieves the *right* memories for *this specific task* and injects them into context.

---

## What Gets Stored

### After Every Task Completes

The agent automatically extracts and stores:

```
Task finishes → Post-task extraction:

1. TASK OUTCOME (always stored)
   - What was asked
   - What tools were used
   - Did it succeed or fail
   - How long it took
   - How much it cost

2. LEARNED FACTS (extracted by LLM, stored if novel)
   - "FinCherry's Itaú parser is in src/parsers/itau.ts"
   - "Nubank statements have dates in DD/MM/YYYY format"
   - "Maria S. is a returning Etsy customer, 3rd order"
   
3. TASK PATTERNS (what worked, what didn't)
   - "CI failure on arche-signal was caused by path rename — 
      check recent renames when path errors occur"
   - "FinCherry upload needs account selection before import"
```

### How Facts Are Extracted

After a task completes, a cheap LLM call (Tier 0, free) reviews the task conversation and extracts:

```
Prompt to extraction LLM:
"Review this task conversation. Extract any NEW facts or knowledge 
that would be useful for future tasks. Only extract things that are:
- Specific and actionable (not vague observations)
- Not already known (check against existing memories below)
- Related to: codebase structure, API behaviors, user preferences,
  project patterns, or recurring issues

Existing memories for this project:
[... current memories ...]

Output JSON:
[
  { "fact": "...", "category": "project|preference|pattern|entity", 
    "project": "fincherry|arche-signal|null", "confidence": 0.9 }
]"
```

**Cost of extraction: ~$0.001 per task** (small input, tiny output, free-tier model). Runs automatically after every task.

---

## Memory Retrieval: Getting the Right Context

When a new task starts, the agent needs to pull relevant memories. Not all memories — just the ones that matter for THIS task.

### Retrieval Strategy (Simple, No Embeddings)

```typescript
async function retrieveMemories(task: Task): Promise<Memory[]> {
  const memories: Memory[] = [];
  
  // 1. Project memories — always include for project-specific tasks
  if (task.project) {
    memories.push(
      ...await db.query(`
        SELECT * FROM agent_memory 
        WHERE project = $1 AND status = 'active'
        ORDER BY access_count DESC, updated_at DESC
        LIMIT 20
      `, [task.project])
    );
  }
  
  // 2. Recent task history — what happened lately on this project
  memories.push(
    ...await db.query(`
      SELECT summary, outcome, tools_used FROM tasks
      WHERE project = $1 AND status IN ('completed', 'failed')
      ORDER BY completed_at DESC
      LIMIT 5
    `, [task.project])
  );
  
  // 3. Global preferences — always include
  memories.push(
    ...await db.query(`
      SELECT * FROM agent_memory
      WHERE category = 'preference' AND status = 'active'
    `)
  );
  
  // 4. Keyword search — find memories matching task description
  if (task.prompt) {
    const keywords = extractKeywords(task.prompt); // simple: split + filter stopwords
    memories.push(
      ...await db.query(`
        SELECT * FROM agent_memory
        WHERE status = 'active'
        AND (
          content ILIKE ANY($1)
          OR tags && $2::text[]
        )
        ORDER BY updated_at DESC
        LIMIT 10
      `, [keywords.map(k => `%${k}%`), keywords])
    );
  }
  
  // 5. Deduplicate and trim to fit context budget
  return deduplicateAndTrim(memories, MAX_MEMORY_TOKENS);
}
```

### Why Not Embeddings/Vector Search?

Embeddings (pgvector) are the "proper" way to do semantic memory retrieval. But for Phase 1:

- **Sam's agent will have maybe 100-500 memories after months of use.** At this scale, keyword search + project filtering is 95% as good as semantic search.
- **pgvector adds complexity** — embedding generation costs money, vector indexes need tuning, and the retrieval quality depends heavily on the embedding model.
- **The memories are structured** — they have project tags, categories, and keywords. This isn't unstructured document search; it's more like a well-organized notebook.

**Decision: PostgreSQL with ILIKE + tags for Phase 1. Add pgvector later if retrieval quality becomes a problem (unlikely under 1000 memories).**

---

## Database Schema

### Core Memory Table

```sql
CREATE TABLE agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- What was learned
  content TEXT NOT NULL,                  -- The actual fact/knowledge
  category VARCHAR(30) NOT NULL,          -- 'project', 'preference', 'pattern', 'entity'
  
  -- Scoping
  project VARCHAR(50),                    -- NULL = global, 'fincherry', 'arche-signal', etc.
  tags TEXT[] DEFAULT '{}',               -- Searchable keywords: ['parser', 'pdf', 'itau']
  
  -- Provenance
  source_task_id UUID REFERENCES tasks(id),  -- Which task created this memory
  confidence DECIMAL(3,2) DEFAULT 0.8,       -- 0-1, how confident is this fact
  
  -- Lifecycle
  status VARCHAR(20) DEFAULT 'active',    -- 'active', 'superseded', 'archived'
  superseded_by UUID REFERENCES agent_memory(id),  -- If this fact was updated
  access_count INTEGER DEFAULT 0,         -- How often this memory is retrieved
  last_accessed_at TIMESTAMPTZ,           -- When it was last used in a task
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast retrieval
CREATE INDEX idx_memory_project ON agent_memory(project) WHERE status = 'active';
CREATE INDEX idx_memory_category ON agent_memory(category) WHERE status = 'active';
CREATE INDEX idx_memory_tags ON agent_memory USING GIN(tags) WHERE status = 'active';
CREATE INDEX idx_memory_content_search ON agent_memory USING GIN(to_tsvector('english', content)) 
  WHERE status = 'active';  -- Full-text search as bonus
```

### Task Table (Already Designed — Extended)

```sql
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- What
  prompt TEXT NOT NULL,                    -- Original task description
  project VARCHAR(50),                     -- Which project this relates to
  trigger_type VARCHAR(20) NOT NULL,       -- 'manual', 'scheduled', 'webhook', etc.
  trigger_source TEXT,                     -- '/prep fincherry', 'cron:morning_briefing', etc.
  
  -- Execution
  status VARCHAR(20) DEFAULT 'queued',     -- 'queued', 'running', 'paused', 'completed', 'failed'
  model_used VARCHAR(50),                  -- Which LLM model was used
  tools_used TEXT[] DEFAULT '{}',          -- ['git.pull', 'fs.readFile', 'github.getCI']
  iterations INTEGER DEFAULT 0,            -- How many agent loop iterations
  
  -- Results
  result TEXT,                             -- Final output/answer
  summary TEXT,                            -- Brief summary for memory/history
  outcome VARCHAR(20),                     -- 'success', 'partial', 'failed', 'cancelled'
  error TEXT,                              -- Error message if failed
  
  -- Context used
  memories_used UUID[] DEFAULT '{}',       -- Which memories were injected for this task
  
  -- Cost
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  total_cost DECIMAL(10,6) DEFAULT 0,
  
  -- Timing
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_project ON tasks(project, completed_at DESC);
CREATE INDEX idx_tasks_status ON tasks(status);
```

### Memory Update Log

```sql
-- Track how memories evolve over time
CREATE TABLE memory_changelog (
  id SERIAL PRIMARY KEY,
  memory_id UUID REFERENCES agent_memory(id),
  action VARCHAR(20) NOT NULL,            -- 'created', 'updated', 'superseded', 'archived'
  old_content TEXT,
  new_content TEXT,
  reason TEXT,                            -- "Updated based on task xyz"
  task_id UUID REFERENCES tasks(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Memory Categories Explained

### `project` — Facts about a specific codebase/project

```
"FinCherry uses Fastify + tRPC for the API layer"
"FinCherry parsers are in src/parsers/, each exports a parse(buffer) function"
"Arche-Signal LoRA models are stored in models/latest/"
"FinCherry's CI runs on GitHub Actions, workflow file is .github/workflows/ci.yml"
```

These are retrieved whenever a task mentions or involves that project.

### `preference` — How Sam likes things done

```
"Sam prefers terse Telegram messages, no fluff"
"Sam wants PRs for all code changes, never auto-merge"
"Sam prefers 720p video downloads, not 1080p"
"Sam's morning briefing should be at 8 AM Montreal time"
```

These are always injected, regardless of task type.

### `pattern` — Lessons learned from past tasks

```
"When CI fails with ENOENT, check if any recent commits renamed directories"
"Nubank PDFs have a summary table on page 1 — skip it when parsing transactions"
"FinCherry upload API returns 401 if the JWT expired — re-authenticate and retry"
"YouTube yt-dlp sometimes fails on age-restricted videos — add --cookies-from-browser"
```

These are retrieved by keyword matching when relevant.

### `entity` — People, accounts, external things

```
"Maria S. is a returning Etsy customer, 3 orders, prefers tote bags"  (Phase 2)
"Nubank account is in BRL, account ID acc_1 in FinCherry"
"GitHub repo fincherry is at github.com/sam/fincherry"
```

These are retrieved when the entity is mentioned in the task.

---

## Memory Lifecycle

### Creation
After every task, the extraction LLM reviews the conversation and suggests new memories. Only stored if:
- The fact is not already known (deduplication check)
- Confidence is above threshold (default 0.7)
- The category is valid

### Updates (Superseding)
If a new fact contradicts an existing one:
```
Existing: "FinCherry parsers are in src/lib/parsers/"
New fact: "FinCherry parsers were moved to src/parsers/"

→ Old memory status → 'superseded', superseded_by → new memory ID
→ New memory created with updated content
→ Change logged in memory_changelog
```

The LLM extraction prompt includes existing memories for the project, so it can detect contradictions.

### Decay (Passive)
Memories that are never accessed gradually lose relevance:
- `access_count` tracks how often a memory is retrieved
- Memories with `access_count = 0` after 60 days → auto-archived
- Frequently accessed memories survive indefinitely

### Manual Management
Sam can manage memories via Telegram:
```
/memory list fincherry          → Show all active memories for FinCherry
/memory add fincherry: "The Itaú parser handles DD/MM/YYYY dates"
/memory delete <id>             → Archive a memory
/memory search parser           → Find memories matching keyword
```

---

## Context Budget

LLM context windows are finite. The agent can't inject 500 memories into every task. Budget allocation:

```
Total context budget: ~8,000 tokens (for Tier 1-2 models with 32K-128K windows)

System prompt (identity + rules):     ~800 tokens  (fixed)
Tool definitions:                     ~1,500 tokens (fixed, depends on enabled tools)
Task prompt + trigger context:        ~500 tokens  (variable)
Retrieved memories:                   ~2,000 tokens (variable, ~20-30 memories)
Recent task history:                  ~1,000 tokens (last 3-5 tasks, summarized)
Working conversation (tool calls):    ~2,200 tokens (grows during task, sliding window)
```

When memories exceed the budget, they're prioritized:
1. Global preferences (always included)
2. Project-specific memories (sorted by access_count)
3. Recent task history
4. Keyword-matched memories
5. Everything else (dropped if over budget)

---

## How "Learning" Actually Works — Example

### Day 1: First FinCherry PDF Upload

```
Task: Upload nubank_jan.pdf to FinCherry
Agent: Authenticates, uploads, asks account selection, imports.
Post-task extraction:
  → Memory: "FinCherry upload API is at POST /api/statements/upload"
  → Memory: "FinCherry auth endpoint is POST /api/auth/login"
  → Memory: "Sam's Nubank account is 'Nubank BRL' (acc_1) in FinCherry"
```

### Day 5: Second FinCherry PDF Upload

```
Task: Upload nubank_feb.pdf to FinCherry
Context injected: [memories from Day 1]
Agent: Already knows the API endpoints, already knows Sam uses Nubank BRL.
  → Skips asking "which account?" because memory says Sam always picks Nubank BRL for BRL statements
  → Just confirms: "Uploading to Nubank BRL. [✅ Import] [🔄 Different account]"
Post-task extraction:
  → Pattern: "BRL statements → Nubank BRL account (auto-select)"
```

### Day 15: Third Upload — Different Bank

```
Task: Upload itau_jan.pdf to FinCherry
Context injected: [memories including "BRL → Nubank" pattern]
Agent: Detects this is Itaú, not Nubank. Pattern doesn't apply.
  → Asks: "Which account? [Nubank BRL] [Itaú BRL]"
  → Sam picks Itaú BRL
Post-task extraction:
  → Memory: "Sam's Itaú account is 'Itaú BRL' (acc_2) in FinCherry"
  → Updated pattern: "BRL statements: if Nubank → acc_1, if Itaú → acc_2"
```

The agent gets faster and more accurate over time — not because it's fine-tuning, but because it accumulates the right facts and patterns.

---

## Database Summary

| Table | Purpose | Rows (est. after 6 months) |
|-------|---------|---------------------------|
| `agent_memory` | Learned facts, patterns, preferences | ~300-500 |
| `tasks` | Task history with outcomes | ~2,000-5,000 |
| `memory_changelog` | How memories evolved | ~500-1,000 |
| `cost_log` | Per-call cost tracking | ~5,000-10,000 |
| `audit_log` | Tool execution audit trail | ~10,000-20,000 |
| `approval_queue` | Pending/resolved approvals | ~100-300 |
| `user_prompts` | Ask-user interactions | ~200-500 |

**Total storage estimate: <100MB after 6 months.** PostgreSQL handles this trivially.

### Why PostgreSQL Is Enough

- **Scale**: Hundreds of memories, not millions. No need for specialized vector DB.
- **Search**: GIN indexes on tags + full-text search (`to_tsvector`) cover keyword retrieval well.
- **Structured**: Memories have categories, projects, tags — structured filtering is more useful than semantic similarity at this scale.
- **Already there**: PostgreSQL is already in the stack for tasks, approvals, cost logs.
- **Upgrade path**: If you ever need semantic search, `pgvector` is a PostgreSQL extension — add it without changing databases.

### What Would Trigger pgvector?

If you notice the agent consistently failing to retrieve relevant memories — for example, it has a memory about "Drizzle ORM migration syntax" but doesn't retrieve it when asked about "database schema changes" because the keywords don't overlap. At that point, embeddings would help bridge the semantic gap. But this is unlikely under 1,000 memories.
