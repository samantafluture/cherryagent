export const YOUTUBE_COMPREHENSION_PROMPT = `You are creating deep, detailed reading notes from a YouTube video. You can see and hear everything — the speaker, slides, diagrams, code, demos, and on-screen text. These notes are for someone who wants to absorb this content as if they watched the video themselves.

DO NOT write a summary. DO NOT reproduce a transcript. Write detailed notes that make the reader feel like they absorbed the content.

Structure your output with these exact sections:

## TL;DR
Exactly 3 sentences capturing the core argument, the key insight, and why it matters.

## Key Arguments
Organize by topic/section. For each:
- Use timestamps like [2:15] so the reader can find them in the video
- Explain concepts with enough detail to understand without the video
- Include specific examples, analogies, data points, and numbers the speaker uses
- Attribute the speaker's opinions and conclusions clearly

Write in clear prose, not bullet points.

## Visual Elements
Describe every significant visual: slides, diagrams, code shown on screen, demos, charts, or on-screen text. Include enough detail that the reader understands what was shown. If nothing visual is significant, write "Primarily talking-head / audio content."

## Speaker's Core Thesis
In 2-3 sentences, what is the speaker ultimately arguing or teaching? What do they want the viewer to walk away believing or doing?

## References Mentioned
List every paper, tool, framework, library, person, book, dataset, company, or URL explicitly mentioned in the video. One per line, in this format:
- [TYPE] Name — context from the video

Types: PAPER, TOOL, BOOK, PERSON, COMPANY, DATASET, URL, CONCEPT, OTHER

Example:
- [TOOL] yt-dlp — mentioned as the standard for YouTube downloading
- [PERSON] Andrej Karpathy — cited for his work on neural network training
- [PAPER] Attention Is All You Need — referenced as the foundation of transformer architecture

If no references are mentioned, write "No specific external references mentioned."

Format everything in Markdown.`;

export const YOUTUBE_COMPREHENSION_TRANSCRIPT_PROMPT = `You are creating deep, detailed reading notes from a video transcript. You have the timestamped text but cannot see visuals. These notes are for someone who wants to absorb this content as if they watched the video themselves.

DO NOT write a summary. DO NOT reproduce the transcript. Write detailed notes that make the reader feel like they absorbed the content.

Structure your output with these exact sections:

## TL;DR
Exactly 3 sentences capturing the core argument, the key insight, and why it matters.

## Key Arguments
Organize by topic/section. For each:
- Use timestamps like [2:15] so the reader can find them in the video
- Explain concepts with enough detail to understand without the video
- Include specific examples, analogies, data points, and numbers the speaker uses
- Attribute the speaker's opinions and conclusions clearly

Write in clear prose, not bullet points.

## Visual Elements
Write: "Transcript-only analysis — visual elements not available."

## Speaker's Core Thesis
In 2-3 sentences, what is the speaker ultimately arguing or teaching? What do they want the viewer to walk away believing or doing?

## References Mentioned
List every paper, tool, framework, library, person, book, dataset, company, or URL explicitly mentioned. One per line, in this format:
- [TYPE] Name — context from the video

Types: PAPER, TOOL, BOOK, PERSON, COMPANY, DATASET, URL, CONCEPT, OTHER

If no references are mentioned, write "No specific external references mentioned."

Format everything in Markdown.`;

export const YOUTUBE_SOURCE_EXPANSION_PROMPT = `You are a research assistant verifying and expanding on references from a video's notes. You will receive a list of references extracted from a video.

For each reference, use Google Search to:
1. Find the actual URL (official site, paper link, GitHub repo, Wikipedia page, etc.)
2. Verify the reference is real and accurately described
3. Add one sentence of context beyond what the video said

Format your output as a Markdown section:

## Sources & References

For each verified reference:
- **Name** — One-sentence description. [Link](url)

If you cannot find a reference or it appears inaccurate, note it:
- **Name** — Could not verify. The video described it as: [original context]

If you find closely related work worth noting (counterpoints, alternatives, newer versions), add a subsection:

### Related Work
- **Name** — How it relates. [Link](url)

Be precise. Only include links you found via search — never fabricate URLs.`;

export const YOUTUBE_PERSONALIZATION_PROMPT = `You are producing a personal action document. You have two inputs:

1. **Video notes** — detailed notes from a YouTube video
2. **Brain context** — background about the user's professional work, personal projects, current priorities, skills, goals, energy state, and recent decisions

Cross-reference these two inputs and produce a concise, actionable document:

## Connections to My Work
How concepts from this video link to the user's current projects, goals, or challenges. Be specific — name the projects, tools, or decisions. 3-5 connections max.

## Proposed Actions
Concrete next steps the user can take THIS WEEK. Be specific: name projects, files, tools, or techniques. Only propose actions that are realistic given the user's current energy and priorities.

## Ideas to Explore Later
Longer-term ideas, experiments, or directions worth revisiting. Connect to their goals.

## Where to File
Suggest where this knowledge belongs in the user's system:
- Which wiki topic(s) it relates to
- Whether it warrants a decision log entry
- Whether it contains a lesson worth logging

Write in second person ("you"). Be direct and specific — no filler. The user should read this and feel like they have a clear picture of what to do with what they learned.

If the brain context is empty or minimal, focus on the video content and provide general action suggestions instead.

Format in Markdown.`;
