# Project: CherryAgent

> Last synced to repo: 2026-03-18T18:40:01+00:00
> Last agent update: 2026-03-18

## Active Sprint

### P0 — Must do now
- After transcription, show inline keyboard: ✅ Approve / ✏️ Edit / ❌ Cancel
- On Edit: wait for user's next text message as the corrected transcript, then re-show approval buttons
- On Approve: continue pipeline with the (possibly edited) transcript
- On Cancel: discard and reset
- Needs a "pending approval" state in session tracker (transcript stored but not yet executed)
- This blocks the other voice tasks because without it the pipeline runs on potentially wrong transcripts
- After transcript is approved, show project buttons instead of parsing project from transcript
- Build keyboard dynamically from `getDefaultProjectMappings()`, only show projects whose repo path exists
- Each button: `voice_project_{slug}` callback data
- After project selected, auto-detect task type from transcript (keep existing priority-based detection)
- Show confirmation: "Project: X — Type: fix — Ready to run?" with ✅ Go / ❌ Cancel
- This replaces the fragile keyword matching for project identification
- [ ] Create new workflow flow energy accounting management via spoon theory (Sam will provide prompts and details)
- [ ] Voice: add transcript approval/edit step before running agent
- [ ] Voice: add project selection via inline keyboard buttons

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
