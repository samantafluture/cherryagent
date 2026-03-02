# CherryAgent — YouTube Workflow: Watch, Listen, Read

**Use case:** Sam sends a YouTube URL via Telegram. The agent produces three outputs:
1. **Video** (MP4) — for watching at the gym (offline)
2. **Audio** (MP3) — for listening on the go
3. **Notes** (text) — key points and details worth knowing, for evening reading

---

## How It Looks from Sam's Phone

```
┌────────────────────────────────────────┐
│ 🍒 CherryAgent                    ┌──┐│
│                                    │  ││
│  Sam:                              │  ││
│  https://youtube.com/watch?v=abc   │  ││
│                                    │  ││
│  🍒:                               │  ││
│  🎬 Got it! Processing...          │  ││
│  "How Neural Networks Really Work" │  ││
│  Duration: 24:31                   │  ││
│                                    │  ││
│  ⏳ Downloading video...           │  ││
│  ⏳ Extracting audio...            │  ││
│  ⏳ Transcribing (Whisper)...      │  ││
│  ⏳ Generating notes...            │  ││
│                                    │  ││
│  ✅ All done! Cost: $0.003         │  ││
│                                    │  ││
│  📹 video_neural_networks.mp4     │  ││
│     (142 MB — 720p)               │  ││
│                                    │  ││
│  🎧 audio_neural_networks.mp3     │  ││
│     (23 MB — 128kbps)             │  ││
│                                    │  ││
│  📝 Notes:                         │  ││
│                                    │  ││
│  HOW NEURAL NETWORKS REALLY WORK  │  ││
│                                    │  ││
│  The Core Idea (0:00 - 3:45)      │  ││
│  Neural networks are essentially   │  ││
│  function approximators. The       │  ││
│  speaker uses a compelling analogy │  ││
│  — imagine a room full of people   │  ││
│  each holding a dial...            │  ││
│                                    │  ││
│  [📄 Full notes attached]          │  ││
│                                    │  ││
└────────────────────────────────────────┘
```

---

## The Workflow Step by Step

### Trigger
Sam pastes a YouTube URL in Telegram (or sends `/yt <url>`)

### Step 1 — Parse & Validate
```
Tool: http.fetch
Action: Hit YouTube oEmbed API to get title, duration, thumbnail
Output: { title: "How Neural Networks Really Work", duration: "24:31", channel: "3Blue1Brown" }
```
Agent sends a progress message: "🎬 Got it! Processing *How Neural Networks Really Work* (24:31)"

### Step 2 — Download Video
```
Tool: media.download
Action: yt-dlp downloads best quality ≤720p (configurable)
Command: yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" -o "{media_dir}/{slug}.mp4" {url}
Output: /opt/cherry-agent/media/neural_networks_20260220.mp4 (142MB)
```

### Step 3 — Extract Audio
```
Tool: media.extractAudio  
Action: ffmpeg extracts audio track and compresses to MP3
Command: ffmpeg -i {video_path} -vn -ab 128k -ar 44100 {audio_path}
Output: /opt/cherry-agent/media/neural_networks_20260220.mp3 (23MB)
```

### Step 4 — Transcribe & Generate Notes

Two paths depending on mode:

**Path A — Default (`/yt <url>`) — Cheap, audio-based:**
```
Tool: media.transcribe
Action: Send audio to Groq Whisper API (turbo — $0.04/hour)
Output: Full timestamped transcript (~4,000 words for a 25min video)
Cost: ~$0.016 for 25 minutes of audio

Then:

Tool: LLM call (DeepSeek V3.1 — $0.15/$0.75 per 1M tokens)
Input: Transcript text
Output: Structured reading notes
Cost: ~$0.002
```

**Path B — Rich mode (`/yt <url> rich`) — Multimodal, sees the video:**
```
Tool: LLM call (Gemini 2.5 Flash — video input)
Action: Send video file directly to Gemini, which watches it and generates notes
Input: 258 tokens/sec × 1500s = 387K tokens
Output: Structured reading notes that include visual context
         (diagrams described, code on screen captured, slides referenced)
Cost: ~$0.13 for 25 minutes
```

Use Path B when the video is visually heavy (coding tutorials, math proofs, slide presentations, demos). Path A captures 90%+ of value for talks and podcast-style content.

### Step 5 — Generate Notes (prompt used by both paths)
```
Tool: LLM call
Prompt: 
  "You are creating reading notes from a video. These notes are for 
  someone who wants to read the content in the evening as a learning exercise.
  
  DO NOT write a summary. DO NOT write a transcript.
  
  Instead, write detailed notes that capture:
  - Key concepts explained with enough detail to understand them without the video
  - Specific examples, analogies, and explanations the speaker uses (these are valuable)
  - Numbers, data points, and references mentioned
  - Timestamps for sections so the reader can find them in the video later
  - The speaker's conclusions and opinions, clearly attributed
  - [Rich mode only] Visual elements: diagrams, code shown, slides, demos
  
  Structure the notes by topic/section with timestamps. Write in clear prose,
  not bullet points. The reader should feel like they absorbed the content."
  
Output: ~1,500-2,500 words of structured notes
```

### Step 6 — Deliver via Telegram
```
Tool: notify.telegram (file send mode)
Actions:
  1. Send MP4 video file (Telegram supports up to 2GB via Local Bot API)
  2. Send MP3 audio file
  3. Send notes as a text message (if short) or as a .txt/.pdf file (if long)
  4. Send cost summary
```

### Step 7 — Cleanup (automatic)
```
Tool: media.cleanup (runs every 6 hours via cron)
Action: Delete video files older than 24h, audio older than 48h
Reason: Files already delivered via Telegram — VPS copy is redundant
```

---

## Cost Breakdown Per Video (25 min average)

### Path A — Default (audio-based notes)

| Step | Provider | Cost |
|------|----------|------|
| Validate (oEmbed fetch) | Free (HTTP) | $0.000 |
| Download (yt-dlp) | Free (local tool) | $0.000 |
| Extract audio (ffmpeg) | Free (local tool) | $0.000 |
| Transcribe (Groq Whisper Turbo) | $0.04/hr | ~$0.016 |
| Generate notes (DeepSeek V3.1) | $0.15/$0.75 per 1M | ~$0.002 |
| Agent routing + orchestration | Free tier (Groq Llama 8B) | $0.000 |
| **Total per video** | | **~$0.02** |

**At 1 video/day = ~$0.60/month. At 3 videos/day = ~$1.80/month.**

### Path B — Rich mode (multimodal, sees the video)

| Step | Provider | Cost |
|------|----------|------|
| Validate + Download + Extract | Same as above | $0.000 |
| Multimodal notes (Gemini 2.5 Flash) | $0.30/$2.50 per 1M | ~$0.13 |
| Agent routing | Free tier | $0.000 |
| **Total per video** | | **~$0.13** |

**At 1 video/day = ~$3.90/month. Use selectively for visual-heavy content.**

---

## New Tools This Surfaces

The YouTube workflow reveals 4 new tools we need to add to the design:

### media.download
```typescript
{
  name: "media.download",
  description: "Download video/audio from YouTube and other supported sites using yt-dlp",
  category: "media",
  parameters: {
    url: { type: "string", description: "Video URL" },
    format: { type: "string", enum: ["video", "audio"], default: "video" },
    maxHeight: { type: "number", default: 720, description: "Max video height in pixels" }
  },
  permissions: ["media:download"],
  requiresApproval: false,
  timeout: 300000  // 5 min for large videos
}
```

### media.extractAudio
```typescript
{
  name: "media.extractAudio",
  description: "Extract audio from video file using ffmpeg",
  category: "media",
  parameters: {
    inputPath: { type: "string" },
    format: { type: "string", enum: ["mp3", "m4a", "opus"], default: "mp3" },
    bitrate: { type: "string", default: "128k" }
  },
  permissions: ["media:process"],
  requiresApproval: false,
  timeout: 120000
}
```

### media.transcribe
```typescript
{
  name: "media.transcribe",
  description: "Transcribe audio to text using Groq Whisper API",
  category: "media",
  parameters: {
    audioPath: { type: "string" },
    language: { type: "string", default: "en" }
  },
  permissions: ["media:transcribe"],
  requiresApproval: false,
  timeout: 180000
}
```

### telegram.sendFile
```typescript
{
  name: "telegram.sendFile",
  description: "Send a file to Sam via Telegram",
  category: "notification",
  parameters: {
    filePath: { type: "string" },
    caption: { type: "string", description: "Message to send with the file" }
  },
  permissions: ["notify:telegram"],
  requiresApproval: false,
  timeout: 120000  // Large file uploads take time
}
```

---

## New System Dependencies

| Tool | What | Install | Docker |
|------|------|---------|--------|
| **yt-dlp** | YouTube downloader | `pip install yt-dlp` | Add to API/Worker Dockerfile |
| **ffmpeg** | Audio/video processing | `apt install ffmpeg` | Add to API/Worker Dockerfile |
| **Groq Whisper** | Speech-to-text | API call (already have Groq key) | N/A |

These are lightweight — yt-dlp is a Python script, ffmpeg is a standard package. Both are already in most Docker base images or trivially added.

---

## VPS Storage Consideration

Videos are **transient** — they exist to be sent to your phone, not stored. Once Telegram delivers the file, the VPS copy is redundant.

**Storage strategy:**
```yaml
media:
  video_retention_hours: 24      # Delete after 24h (safety buffer post-Telegram send)
  audio_retention_hours: 48      # Slightly longer (might not listen same day)
  notes_retention_days: 30       # Text is tiny, keep for reference
  max_storage_gb: 5              # Hard cap
  video_max_height: 720
  audio_bitrate: "128k"
  cleanup_cron: "0 */6 * * *"   # Every 6 hours
```

With 24h retention: typically <500MB stored at any time. No disk pressure even on small VPS.

---

## Workflow Diagram

```
 Sam sends YouTube URL via Telegram
              │
              ▼
 ┌─────────────────────────┐
 │   Telegram Bot receives  │
 │   URL, creates task      │
 └────────────┬────────────┘
              │
              ▼
 ┌─────────────────────────┐
 │   Agent Loop starts      │
 │   Router: Tier 0 (free)  │
 └────────────┬────────────┘
              │
    ┌─────────┴──────────┐
    ▼                    ▼
 ┌────────┐    ┌──────────────┐
 │Validate│    │ Send progress│
 │URL     │    │ to Telegram  │
 └───┬────┘    └──────────────┘
     │
     ▼
 ┌──────────────┐
 │ yt-dlp       │──→ video.mp4 saved to /media/
 │ download     │
 └──────┬───────┘
        │
        ▼
 ┌──────────────┐
 │ ffmpeg       │──→ audio.mp3 saved to /media/
 │ extract      │
 └──────┬───────┘
        │
        ├──────── MODE? ────────┐
        │                       │
        ▼ (default)             ▼ (rich)
 ┌──────────────┐       ┌──────────────────┐
 │ Groq Whisper │       │ Gemini 2.5 Flash │
 │ transcribe   │       │ (video input)    │
 │ $0.016       │       │ $0.13            │
 └──────┬───────┘       │ Sees visuals,    │
        │               │ diagrams, code   │
        ▼               └────────┬─────────┘
 ┌──────────────┐                │
 │ DeepSeek V3.1│                │
 │ notes from   │                │
 │ transcript   │                │
 │ $0.002       │                │
 └──────┬───────┘                │
        │                        │
        └───────────┬────────────┘
                    │
                    ▼
 ┌──────────────────────────┐
 │ Telegram: send files      │
 │  📹 video.mp4            │
 │  🎧 audio.mp3            │
 │  📝 notes (text/file)    │
 │  💰 cost: $0.02 / $0.13  │
 └──────────────────────────┘
        │
        ▼
 ┌──────────────────────────┐
 │ Cleanup (24h for video,   │
 │ 48h for audio)            │
 └──────────────────────────┘
```

---

## Shortcut Command

Since this will be a frequent workflow, the Telegram bot gets a dedicated command:

```
/yt <url>                    → Path A: video + audio + notes (cheap, audio-based)
/yt <url> rich               → Path B: video + audio + notes (multimodal, sees visuals — 6x more)
/yt <url> audio              → Audio + notes only (no video download)
/yt <url> notes              → Notes only (cheapest — downloads audio for transcription, discards it)
```

Use `rich` when the video has important visuals: coding tutorials, math, diagrams, slides, demos.

The agent could also accept a **batch**:
```
/yt
https://youtube.com/watch?v=abc
https://youtube.com/watch?v=def
https://youtube.com/watch?v=ghi
```
Queues all three as separate tasks, processes sequentially.

---

## Design Improvements Surfaced

This workflow reveals several improvements needed in the CherryAgent design:

| # | Improvement | Where |
|---|------------|-------|
| 1 | **New `media` tool category** with download, extract, transcribe tools | Layer 2 (Tools) |
| 2 | **Telegram file sending** — bot needs to send video, audio, documents | Telegram Bot (M5) |
| 3 | **Telegram file receiving** — bot should accept files as task input | Telegram Bot (M5) |
| 4 | **Transient storage** — 24h video / 48h audio retention, not 7 days | Layer 3 (Body) |
| 5 | **Progress messages** — agent sends intermediate status updates during long tasks | Agent Loop |
| 6 | **Shortcut commands** — `/yt`, `/etsy` etc. for frequent workflows | Telegram Bot |
| 7 | **`yt-dlp` and `ffmpeg`** as system dependencies in Docker images | Infrastructure |
| 8 | **Groq Whisper** as a provider in the cost tracker (audio pricing, not token pricing) | Cost Router |
| 9 | **Batch task support** — queue multiple URLs as individual tasks from one message | Task Service |
| 10 | **Media path config** — environment-aware paths for media storage | Config |
| 11 | **Multimodal `rich` mode** — Gemini video input for visual-heavy content | Cost Router + Notes |
| 12 | **No transcript stored** — transcript is an intermediate artifact, not an output | Pipeline simplification |
