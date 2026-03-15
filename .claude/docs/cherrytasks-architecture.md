# CherryTasks — Architecture & Implementation Plan

## Overview

CherryTasks is a task management system built around the existing `.claude/tasks.md` convention across Sam's project repos. It replaces the Obsidian + Syncthing mobile workflow with a VPS-centered API that syncs through GitHub, accessed primarily via Telegram (CherryAgent) on mobile and Claude Code on both desktop and mobile.

### Problem Statement

The current workflow has three compounding mobile friction points:

1. **Syncthing-Fork on Android** breaks every few weeks (background process killed by OS), leaving task files out of sync
2. **Obsidian mobile** is clunky for quick task operations (reordering, quick adds, status changes)
3. **Claude Code on mobile** can't SSH to the VPS, creating a disconnect when task files aren't in sync via Git

### Design Principles

- The VPS is the single source of truth for task state
- `tasks.md` files in each repo remain the canonical format (markdown in, markdown out)
- GitHub is the sync bridge for Claude Code mobile (no SSH required)
- Telegram is the primary mobile interface (fast, reliable, always available)
- Claude Code is a full participant — it reads, writes, and updates tasks as it works
- Task commits are squashed to keep Git history clean

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        VPS (Hostinger)                       │
│                                                              │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │  Task API     │◄──►│  Project Repos                    │   │
│  │  (Fastify)    │    │  ├── cherryagent/.claude/tasks.md │   │
│  │               │    │  ├── cherrytree/.claude/tasks.md  │   │
│  │  - CRUD tasks │    │  ├── fincherry/.claude/tasks.md   │   │
│  │  - Parse MD   │    │  └── ...                          │   │
│  │  - Write MD   │    └──────────────┬───────────────────┘   │
│  │  - Git sync   │                   │                       │
│  └──────┬───────┘                   │ git push (squashed)   │
│         │                            ▼                       │
│  ┌──────┴───────┐           ┌──────────────┐                │
│  │ CherryAgent   │           │   GitHub      │                │
│  │ (Telegram Bot)│           │   (Remote)    │                │
│  └──────┬───────┘           └──────┬───────┘                │
│         │                          │                         │
└─────────┼──────────────────────────┼─────────────────────────┘
          │                          │
          ▼                          ▼
  ┌───────────────┐         ┌────────────────────┐
  │ Telegram App   │         │ Claude Code         │
  │ (Pixel/Mobile) │         │ (Mobile & Desktop)  │
  └───────────────┘         └────────────────────┘

  Desktop also: Claude Code ──SSH──► VPS (direct file access)
```

### Data Flow

**Mobile task capture (Telegram):**
1. Sam sends `/task cherryagent add "Fix webhook auth error"` via Telegram
2. CherryAgent → Task API → appends to `cherryagent/.claude/tasks.md`
3. Task API → `git add tasks.md && git commit (squash) && git push`
4. GitHub is now up to date

**Claude Code mobile reads/writes:**
1. Claude Code clones or reads from GitHub (SSH to VPS unavailable on mobile)
2. Sees the latest `tasks.md` including what was just added via Telegram
3. Claude Code makes changes (marks done, adds subtasks, updates status)
4. Pushes to GitHub
5. VPS pulls changes via webhook or cron (see Git Sync section)

**Claude Code desktop:**
1. SSH into VPS, direct access to repo files
2. Can also talk to Task API directly for structured operations
3. Changes are committed and pushed to GitHub same as above

**Cross-project overview (Telegram):**
1. Sam sends `/tasks all`
2. Task API scans all project directories for `tasks.md` files
3. Returns formatted summary: project names, task counts by status, in-progress items

---

## Task API

### Location

The Task API is a module within CherryAgent (not a separate service), since CherryAgent already runs on the VPS and handles Telegram communication. This avoids running another process and keeps the stack simple.

### Endpoints (Internal Module API)

These are internal function calls within CherryAgent, not HTTP endpoints (unless you later want external access):

```
listProjects()
  → Returns all projects that have a .claude/tasks.md file

getTasks(projectSlug)
  → Parses tasks.md for the given project, returns structured data

addTask(projectSlug, { title, type, priority?, status? })
  → Appends a new task to tasks.md

updateTask(projectSlug, taskId, { status?, title?, notes? })
  → Updates an existing task in place

reorderTask(projectSlug, taskId, direction | position)
  → Moves a task up/down or to a specific position

deleteTask(projectSlug, taskId)
  → Removes a task from the file

getOverview()
  → Scans all projects, returns aggregated summary
```

### Markdown Parser/Serializer

The parser reads the existing `tasks.md` format and produces structured objects. The serializer writes them back. This must be **lossless** — any content in the file that isn't a recognized task (notes, headers, context sections) must be preserved on round-trip.

Example `tasks.md` format (adapt to your existing convention):

```markdown
# CherryAgent Tasks

## In Progress
- [ ] [P1] Fix webhook auth token refresh — not regenerating on expiry
- [ ] [P2] Add retry logic to Telegram message sending

## Backlog
- [ ] [P2] Implement /tasks all command for cross-project overview
- [ ] [P3] Add image recognition for receipt scanning

## Done
- [x] [P1] Set up Gemini Flash integration
- [x] [P2] Configure fire-and-forget task execution
```

Parsed to:

```typescript
interface Task {
  id: string;          // generated, stable (e.g., hash of original title or incremental)
  title: string;
  type: 'task' | 'bug' | 'feature';
  priority: 'P1' | 'P2' | 'P3';
  status: 'in-progress' | 'backlog' | 'done' | 'blocked';
  notes?: string;
  checkbox: boolean;   // true = [x], false = [ ]
}
```

**Important:** The parser must handle variations in how tasks are currently written across projects. Start by auditing your existing `tasks.md` files to nail down the exact format before building the parser.

---

## Telegram Interface (CherryAgent Commands)

### Per-Project Commands

```
/tasks <project>                    — List tasks for a project (grouped by status)
/task <project> add "<title>"       — Add a task to backlog
/task <project> bug "<title>"       — Add a bug (auto-tagged, P1 default)
/task <project> done <id>           — Mark task complete
/task <project> wip <id>            — Mark task in-progress
/task <project> block <id>          — Mark task blocked
/task <project> up <id>             — Move task up in its section
/task <project> down <id>           — Move task down
/task <project> drop <id>           — Delete a task
/task <project> note <id> "<text>"  — Add a note to a task
/task <project> edit <id> "<title>" — Edit task title
```

### Cross-Project Overview

```
/tasks all
```

Example output:

```
📋 All Projects Overview

🔧 cherryagent (3 active / 8 total)
  ▸ 2 in progress, 1 blocked
  ▸ Top: Fix webhook auth token refresh

🌳 cherrytree (2 active / 12 total)
  ▸ 2 in progress
  ▸ Top: Implement drag-and-drop reorder

💰 fincherry (1 active / 5 total)
  ▸ 1 in progress
  ▸ Top: PDF statement parser for N26

📊 Total: 6 active across 3 projects
```

### Inline Keyboard Buttons

After showing a task list, Telegram inline keyboards allow quick actions without typing:

```
[✅ Done] [⬆️ Up] [⬇️ Down] [🚫 Drop]
```

These make mobile task management fast — tap instead of type.

---

## Git Sync Strategy

### VPS → GitHub (on every write)

After the Task API writes to a `tasks.md` file:

```bash
cd /path/to/project-repo
git add .claude/tasks.md
# Squash: amend the last commit if it was also a task update
LAST_MSG=$(git log -1 --pretty=%s)
if [[ "$LAST_MSG" == "chore: update tasks" ]]; then
  git commit --amend --no-edit
  git push --force-with-lease
else
  git commit -m "chore: update tasks"
  git push
fi
```

This keeps the commit history clean — consecutive task updates collapse into a single commit. Non-task commits in between are preserved normally.

### GitHub → VPS (pull external changes)

For changes made by Claude Code mobile (which pushes to GitHub directly):

**Option A: GitHub Webhook (recommended)**
- Set up a webhook on each repo pointing to a CherryAgent endpoint
- On push events that modify `.claude/tasks.md`, pull the latest
- Near-instant sync

**Option B: Cron Poll (simpler)**
- A cron job every 2-5 minutes runs `git pull` on all project repos
- Slightly delayed but zero configuration on GitHub's side

**Conflict handling:**
- Since only one actor writes at a time in practice (either Telegram or Claude Code), conflicts should be rare
- If a conflict occurs: VPS state wins, conflicting remote changes are stashed and a Telegram notification is sent to Sam for manual review

---

## Claude Code Skill

A shared skill installed once and referenced by all projects. This teaches Claude Code how the task system works.

### Skill Location

```
~/.claude/skills/cherrytasks/
├── SKILL.md          # Main skill doc
└── task-format.md    # Reference for the tasks.md format
```

### SKILL.md Content (Draft)

```markdown
# CherryTasks Skill

## Overview
This project uses CherryTasks for task management. Tasks live in
`.claude/tasks.md` in the repo root.

## Reading Tasks
- Check `.claude/tasks.md` for the current task list
- Tasks are grouped by status: In Progress, Backlog, Done, Blocked
- Priority is marked as [P1], [P2], [P3]

## Updating Tasks
When you complete a task, mark it done:
- Change `- [ ]` to `- [x]`
- Move it to the `## Done` section
- Commit with message: `chore: update tasks`

When you start working on a task:
- Move it to `## In Progress`
- Commit with message: `chore: update tasks`

When you hit a blocker:
- Move the task to `## Blocked`
- Add a note below the task line with the blocker details
- Commit with message: `chore: update tasks`

## Adding Tasks
If you discover work that needs doing (bugs found during development,
refactoring needs, etc.), add them to `## Backlog` with appropriate
priority.

## Commit Convention
- Always use `chore: update tasks` as the commit message for task changes
- This allows the VPS sync system to squash consecutive task commits
- Never mix task updates with code changes in the same commit

## On Mobile (No SSH)
If you cannot SSH to the VPS, read and write tasks via the GitHub repo.
Push your changes to GitHub and the VPS will pull them automatically.
```

### Per-Project Reference

Each project's `CLAUDE.md` includes a one-liner:

```markdown
## Task Management
See ~/.claude/skills/cherrytasks/SKILL.md for task conventions.
Tasks: .claude/tasks.md
```

---

## Project Bootstrap

When starting a new project, run this checklist (automate later):

1. **Create task file:**
   ```bash
   mkdir -p .claude
   cat > .claude/tasks.md << 'EOF'
   # <Project Name> Tasks

   ## In Progress

   ## Backlog

   ## Done
   EOF
   ```

2. **Add skill reference to CLAUDE.md:**
   ```markdown
   ## Task Management
   See ~/.claude/skills/cherrytasks/SKILL.md for task conventions.
   Tasks: .claude/tasks.md
   ```

3. **Register with CherryAgent:**
   Add the project path to CherryAgent's project registry so it knows
   where to find the repo and what slug to use for Telegram commands.

4. **Set up GitHub webhook** (if using webhook sync):
   Point to CherryAgent's webhook endpoint for push events.

---

## Implementation Phases

### Phase 1: Task API Core
- [ ] Markdown parser/serializer (lossless round-trip)
- [ ] CRUD operations on tasks
- [ ] Audit existing tasks.md files across all projects for format consistency
- [ ] Standardize format if needed (migration)

### Phase 2: Git Sync
- [ ] Auto-commit + squash on write
- [ ] Auto-push to GitHub
- [ ] GitHub → VPS pull (webhook or cron)
- [ ] Conflict detection + Telegram notification

### Phase 3: Telegram Commands
- [ ] Per-project task commands (add, done, wip, block, up, down, drop)
- [ ] Cross-project overview (/tasks all)
- [ ] Inline keyboard buttons for quick actions
- [ ] Project slug autocomplete / fuzzy matching

### Phase 4: Claude Code Skill
- [ ] Write shared skill documentation
- [ ] Install in ~/.claude/skills/cherrytasks/
- [ ] Add reference to CLAUDE.md in all existing projects
- [ ] Test mobile Claude Code flow (GitHub read → edit → push → VPS pull)

### Phase 5: Project Bootstrap
- [ ] Create bootstrap script or template
- [ ] Document the new-project checklist
- [ ] Migrate all existing projects to standardized format

---

## What Gets Eliminated

| Before | After |
|--------|-------|
| Syncthing-Fork on Android | Removed entirely |
| Obsidian mobile for tasks | Replaced by Telegram |
| Obsidian vault sync for tasks | Replaced by GitHub |
| Manual SSH workarounds on mobile | GitHub as sync bridge |
| Per-project task setup inconsistency | Shared skill + bootstrap |

## What Stays

| Component | Role |
|-----------|------|
| `tasks.md` in each repo | Canonical task format (unchanged) |
| Claude Code on desktop | SSH to VPS, direct file access |
| Claude Code on mobile | Via GitHub (read/write/push) |
| CherryAgent on VPS | Now includes Task API module |
| GitHub repos | Sync bridge + mobile access point |

---

## Open Questions

1. **Task ID stability:** How to generate stable IDs that survive markdown edits? Options: line-based index (fragile), title hash (breaks on rename), or embedded ID in the markdown (e.g., `<!-- id:abc123 -->`).

2. **Multi-device conflict window:** If Sam adds a task via Telegram and Claude Code mobile pushes a change to the same file within the webhook/cron delay, how to handle? Current plan: VPS wins, notify via Telegram.

3. **Existing format audit:** Are all current `tasks.md` files in the same format, or will the parser need to handle variations?
