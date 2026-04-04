# CherryAgent — YouTube Personal Insights Pipeline

**Status:** Design  
**Related:** [CherryAgent-YouTube-Workflow.md](./CherryAgent-YouTube-Workflow.md)  
**Task:** Enhance /yt notes — always use Gemini video mode + personal insights pipeline

---

## Problem

The current `/yt` command produces good notes, but they're passive — a summary of what was said. Two issues:

1. **Path A (transcript-based) misses visual content.** Diagrams, code on screen, slides, demos — all lost when we only transcribe audio. Sam watches videos with heavy visual content (coding tutorials, architecture talks, business strategy presentations).

2. **Notes don't connect to Sam's life.** A video about, say, indie SaaS pricing strategies produces generic notes. But Sam is actively building Surpride, CherryOps, Voilà Prep — the notes should surface how those pricing strategies apply to *his* specific products and situation.

---

## Design

### Change 1: Always Use Gemini Video Mode

Drop the transcript-based Path A as the default. Every `/yt` call sends the video file directly to Gemini 2.5 Flash for multimodal analysis.

**Why:** The cost increase is modest (~$0.02 → ~$0.13 per video), and Sam is already investing 20-30 minutes watching these videos. Missing visual context defeats the purpose of taking notes. The transcript path can remain as a fallback (`/yt <url> cheap`) for podcast-style content where visuals don't matter.

**Implementation:**
- In `youtube-pipeline.ts`, change the default mode from `"default"` to `"rich"`
- Rename the modes: `standard` (Gemini video, was "rich") and `transcript` (Whisper, was "default")
- Update the `/yt` command parser to reflect new defaults

### Change 2: Personal Insights Pipeline (Async, Two-Phase)

The key insight: **standard notes are delivered immediately, personal insights are deferred.** Sam reads notes in the evening. The deep personal analysis happens when he has headspace for it — maybe the next day, maybe the weekend.

#### Phase 1 — Immediate Delivery (existing flow, enhanced)

When Sam sends `/yt <url>`, the agent:

1. Downloads video, sends to Gemini for notes (now always multimodal)
2. Delivers via Telegram: video file + audio file + standard notes
3. **NEW:** Appends a brief "personal relevance scan" at the end of the notes:
   ```
   ---
   🧠 Potential connections to your work:
   - Surpride: [1-2 sentence connection if any]
   - CherryOps: [1-2 sentence connection if any]
   - General: [1-2 sentence connection if any]
   
   💡 Deep analysis task created. Run when ready.
   ```
4. **NEW:** Auto-creates a task in CherryAgent's backlog:
   ```
   - [ ] Deep analysis: [Video Title] `[M]` #insights
   ```
   The task stores metadata: video URL, notes content, date watched.

This relevance scan is lightweight — Gemini already has the video context, we just add a short system prompt asking it to scan for connections to Sam's known projects (Surpride/Etsy POD, CherryOps/dev tools, Voilà Prep/French learning, samantafluture/personal brand).

#### Phase 2 — Deep Personal Analysis (on demand)

When Sam asks to work on a deep analysis task (via Telegram or Claude Code), the agent runs a multi-step pipeline:

**Step 1: Context Gathering**
The agent reads relevant project files to understand Sam's current state:
- `CLAUDE.md` files across active projects (architecture, goals, constraints)
- Recent `tasks.md` files (what's in progress, what's blocked)
- Recent blog posts (what Sam's been thinking about publicly)
- The original video notes from Phase 1

**Step 2: Interview (via Telegram)**
The agent asks Sam 3-5 targeted questions based on the video content and project context:
- "The video talked about [X strategy]. You're currently doing [Y] with Surpride. What's your gut reaction — does [X] feel applicable or is your situation different?"
- "The speaker mentioned [Z tool/approach]. Have you considered this for [project]? What's held you back?"
- "Which part of the video stuck with you most? What made you save it?"

The interview is conversational, not a form. The agent adapts follow-up questions based on Sam's answers.

**Step 3: Insights Document**
The agent produces a structured document saved to `.claude/docs/insights/` with:

```markdown
# Insights: [Video Title]
**Video:** [URL]
**Watched:** [date]
**Analyzed:** [date]

## Key Takeaways (from the video)
[3-5 core concepts, written with visual context included]

## How This Applies to Your Work

### Surpride
[Specific, actionable connections between video concepts and Surpride's 
current state — referencing actual products, pricing, seasonal strategy]

### [Other relevant project]
[Same treatment]

## Suggested Actions
- [ ] [Concrete next step derived from the analysis]
- [ ] [Another concrete step]
- [ ] [Optional stretch goal]

## Raw Interview Notes
[Sam's answers preserved for future reference]
```

**Step 4: Task Creation**
Any suggested actions that Sam confirms get added as tasks to the relevant project's `tasks.md`.

---

## Architecture

### New Files

```
packages/tools/src/media/
  personal-insights.ts    — orchestrates the Phase 2 pipeline
  relevance-scan.ts       — lightweight project-connection scan for Phase 1
  insights-interview.ts   — Telegram interview flow

packages/tools/src/media/prompts/
  relevance-scan.md       — system prompt for quick relevance scan
  deep-analysis.md        — system prompt for full insights generation
  interview-questions.md  — template for generating interview questions
```

### Data Flow

```
/yt <url>
  │
  ├─→ [existing] Download → Gemini video notes → Deliver via Telegram
  │
  ├─→ [new] Relevance scan (same Gemini call, extended prompt)
  │     └─→ Append to notes message
  │
  └─→ [new] Create backlog task: "Deep analysis: [title]" #insights
        │
        │  (later, when Sam asks)
        │
        ├─→ Read CLAUDE.md + tasks.md from relevant projects
        ├─→ Read original video notes
        ├─→ Interview Sam via Telegram (3-5 questions)
        ├─→ Generate insights doc (Gemini or Claude)
        ├─→ Save to .claude/docs/insights/[slug].md
        └─→ Optionally create action tasks in project backlogs
```

### Cost Estimate

| Step | Provider | Cost |
|------|----------|------|
| Video notes (Gemini 2.5 Flash, always) | $0.30/$2.50 per 1M | ~$0.13 |
| Relevance scan (same call, +200 tokens output) | included | ~$0.00 |
| Deep analysis — context reading | Free (local files) | $0.00 |
| Deep analysis — interview (3-5 exchanges) | Gemini Flash | ~$0.01 |
| Deep analysis — insights generation | Gemini Flash | ~$0.02 |
| **Total: standard /yt** | | **~$0.13** |
| **Total: /yt + deep analysis** | | **~$0.16** |

---

## Open Questions

1. **Which LLM for deep analysis?** Gemini Flash is cheap but Claude might produce better personal insights. Could use Gemini for the interview and Claude for the final synthesis.

2. **How much project context to load?** Reading all CLAUDE.md files across 10+ projects could be a lot of tokens. Maybe only load projects flagged in the relevance scan.

3. **Interview format:** Telegram text works but could also do voice notes (Sam sends voice, Whisper transcribes, agent responds with text). More natural for mobile.

4. **Insights storage:** `.claude/docs/insights/` in the CherryAgent repo, or a dedicated insights repo? The former keeps everything together, the latter avoids bloating the agent repo.

5. **Retention:** How long to keep video files vs insights docs? Videos are transient (24h), but insights docs are permanent reference material.
