# Project: CherryAgent

> Last synced to repo: 2026-03-20T23:30:01+00:00
> Last agent update: 2026-03-20

## Active Sprint

### P0 — Must do now
- [ ] Fix blog command that is not persisting

### P1 — Should do this week
- Current problem: raw transcript is too vague for Gemini Flash, it lacks direction
- Fix 1: Add a "planning" step — before coding, ask Gemini to analyze the task and list which files need changes and what changes are needed, return as structured JSON
- Fix 2: Smart file selection — use the planning step output to only read files that are relevant (instead of reading up to 30 random files)
- Fix 3: Include repo conventions in system prompt — read `CLAUDE.md`, `package.json`, `tsconfig.json` if they exist, and include them as context
- Fix 4: Better system prompt — include task type-specific instructions (e.g. "for fix tasks, look for the bug first and explain what's wrong before changing code")
- Fix 5: Multi-turn — if Gemini's first attempt has no file changes, retry once with a more specific prompt asking it to actually produce changes
- [ ] Voice: improve Gemini agent code quality with better context and prompting

### P2 — Nice to have

## Blocked

## Completed (recent)
- [x] Voice: replace hardcoded project list with dynamic discovery (fixes missing recordoc) ✅ 2026-03-20
- [x] CI: make deploy resilient to nginx config errors ✅ 2026-03-20
- [x] VPS: issue SSL cert for samantafluture.com + add ACME challenge to nginx config ✅ 2026-03-20
- [x] Voice: add transcript approval/edit step before running agent ✅ 2026-03-20
- [x] Voice: add project selection via inline keyboard buttons ✅ 2026-03-20
- [x] Create new workflow flow energy accounting management via spoon theory (Sam will provide prompts and details) ✅ 2026-03-18
- [x] Fix bug on bot answer - name appears as Unknown when listing all ✅ 2026-03-18
- [x] Voice: replace Claude CLI with Gemini Flash agent, GitHub API for PRs ✅ 2026-03-18
- [x] Fix bug — /task cherryagent showed Unknown as project name ✅ 2026-03-15
- [x] Build CherryTasks Phase 3 — Telegram commands ✅ 2026-03-15
- [x] Build CherryTasks Phase 2 — git sync ✅ 2026-03-15
- [x] Build CherryTasks Phase 1 — parser and CRUD API ✅ 2026-03-15

## Notes
- Check CLAUDE.md for architectural decisions before starting work
- VPS IP: 187.124.67.117, SSH user: sam
- Telegram bot with food logger, YouTube, cost tracking, inspiration, and task management
