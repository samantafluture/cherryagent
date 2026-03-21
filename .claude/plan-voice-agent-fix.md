# Voice Agent Fix Plan

## Root Cause Analysis

### Issue 1: Agent doesn't do actual work (only tasks.md changes on pushed branch)

There are **three compounding bugs** causing this:

#### Bug A: `git add -u` doesn't stage new files (`git-automation.ts:19`)
`createBranchAndPush()` uses `git add -u` which **only stages modifications to already-tracked files**. If the Gemini agent creates new files (via `writeFile` in `gemini-agent.ts:135`), those files are **never staged and never committed**. The only change that gets committed is whatever was already modified on disk — in this case, `tasks.md` changes from the task management system (Telegram `/task` commands trigger `saveTaskFile` + `commitAndPush` which can leave uncommitted serialization diffs).

#### Bug B: No baseline checkout before branching (`git-automation.ts:16`)
`createBranchAndPush()` runs `git checkout -b <branch>` from whatever branch/state the repo is currently on. It doesn't ensure we're on `main` first. If a previous voice task or task sync left the repo on a different branch or with dirty state, the new branch inherits that state. Any pending `tasks.md` serialization changes get swept into the voice commit.

#### Bug C: Gemini agent produces no meaningful changes (or only trivial ones)
The agent is fundamentally limited:
1. **Raw transcript as prompt** — voice transcripts are vague, conversational. No planning step to convert them into actionable coding instructions.
2. **Blind file discovery** (`gemini-agent.ts:158-183`) — walks the repo in directory order, caps at 30 files, skips `.claude/` (hides CLAUDE.md conventions). For non-trivial repos, the 30 most important files are unlikely to be the first 30 found.
3. **8192 max output tokens** (`gemini-agent.ts:101`) — must return COMPLETE file contents (not diffs). A single 200-line file exhausts the budget. The agent often returns `files: []` because it can't fit the output.
4. **No repo conventions context** — CLAUDE.md, package.json, tsconfig.json are not explicitly prioritized, so the agent doesn't know the project's patterns.
5. **No validation** — if the agent returns 0 files, the pipeline reports "no changes" but the branch may still get created with just the stale tasks.md diff (due to Bug A+B).

### Issue 2: PR creation fails

The PR creation itself (`createDraftPr`) is correctly implemented, but it fails because:
1. **Push may silently succeed with only tasks.md** — due to Bug A, the branch has only a tasks.md change, then the PR is created but looks empty/wrong.
2. **If push fails**, the error propagation is correct (returns false), but the user sees "Branch was pushed — create PR manually" even though the branch has no real changes.
3. **Missing `GITHUB_TOKEN`** — if not set, `getGitHubToken()` throws, but this seems to be configured correctly since you mentioned PRs are sometimes created.

The actual PR creation failure likely comes from the push step failing or the branch having no meaningful diff against `main`.

---

## Fix Plan

### Step 1: Fix git staging to include new files (`git-automation.ts`)

**File:** `packages/tools/src/voice/git-automation.ts`

In `createBranchAndPush()`:
- Before creating the branch, ensure we're on `main`: `git checkout main` + `git pull origin main`
- After the agent writes files, use `git add .` (or explicitly add the changed files) instead of `git add -u`
- Add a `.gitignore`-safe approach: use `git add --all` but with explicit exclusions, OR pass the list of files the agent changed from `runGeminiAgent` result
- Better: accept a `changedFiles` parameter from the caller and `git add` those specific files

In `pushExistingBranch()`:
- Same fix: use `git add --all` or explicit file list instead of `git add -u`

### Step 2: Ensure clean baseline before agent runs (`voice.ts`)

**File:** `packages/api/src/telegram/handlers/voice.ts`

In `runVoicePipeline()`:
- Before calling `runGeminiAgent()`, ensure the repo is on `main` and clean:
  - `git checkout main`
  - `git pull origin main` (fetch latest)
  - `git stash` if there are uncommitted changes (to prevent task.md leaking)
- After the agent runs, pass the list of changed files to `createBranchAndPush()`

### Step 3: Return changed file paths from Gemini agent (`gemini-agent.ts`)

**File:** `packages/tools/src/voice/gemini-agent.ts`

Modify `runGeminiAgent()` to return the list of file paths it wrote:
- Add `changedFiles: string[]` to `AgentRunResult`
- Populate it with the relative paths of files written to disk
- This allows the git staging step to add exactly those files

### Step 4: Add a planning step before code generation (`gemini-agent.ts`)

**File:** `packages/tools/src/voice/gemini-agent.ts`

Add a two-phase approach:
1. **Phase 1 — Plan:** Send transcript + file listing (paths only, no content) to Gemini. Ask it to return a JSON plan: `{ relevantFiles: string[], approach: string, filesToCreate: string[] }`. This is cheap (small input/output).
2. **Phase 2 — Execute:** Read only the relevant files identified in the plan. Send those + the approach + the original transcript. This focuses context and reduces token waste.

### Step 5: Prioritize convention files in discovery (`gemini-agent.ts`)

**File:** `packages/tools/src/voice/gemini-agent.ts`

In `discoverFiles()` or the new planning step:
- Always include: `CLAUDE.md`, `package.json`, `tsconfig.json`, `.env.example`
- Read these first before counting toward the 30-file limit
- Include `.claude/` in discovery (remove the `startsWith(".")` skip for `.claude` specifically)

### Step 6: Increase max output tokens (`gemini-agent.ts`)

**File:** `packages/tools/src/voice/gemini-agent.ts`

- Increase `maxTokens` from 8192 to at least 32768 (Gemini 2.5 Flash supports up to 65536)
- This gives the agent room to return complete file contents for multiple files

### Step 7: Improve system prompt with task-specific guidance (`gemini-agent.ts`)

**File:** `packages/tools/src/voice/gemini-agent.ts`

Enhance `buildSystemPrompt()`:
- Include repo conventions from CLAUDE.md (read it and append)
- Add task-type-specific instructions (e.g., "for fix tasks, identify the bug before changing code")
- Instruct the agent to focus on minimal, targeted changes
- Remind it that 0-file responses are failures — it should always attempt something

### Step 8: Add validation before commit (`voice.ts`)

**File:** `packages/api/src/telegram/handlers/voice.ts`

In `runVoicePipeline()`, after agent runs:
- If `result.filesChanged === 0`, don't proceed to git ops at all (already handled, but verify no branch is left behind)
- If the only changed files are in `.claude/`, treat as "no meaningful changes" and report failure
- Add a `git diff --stat` report to the Telegram message so the user can see what actually changed

---

## Implementation Order

1. **Step 3** — Add `changedFiles` to AgentRunResult (type change, needed by others)
2. **Step 1** — Fix git staging (critical bug fix)
3. **Step 2** — Ensure clean baseline (critical bug fix)
4. **Step 5** — Prioritize convention files (quick win)
5. **Step 6** — Increase max tokens (quick win)
6. **Step 7** — Improve system prompt (quick win)
7. **Step 4** — Add planning step (biggest impact on quality)
8. **Step 8** — Add validation (safety net)

## Files to Modify

- `packages/tools/src/voice/types.ts` — add `changedFiles` to `AgentRunResult`
- `packages/tools/src/voice/gemini-agent.ts` — planning step, file discovery, system prompt, token limit, return changed files
- `packages/tools/src/voice/git-automation.ts` — fix staging, ensure clean baseline
- `packages/api/src/telegram/handlers/voice.ts` — clean baseline, pass file list, validation
