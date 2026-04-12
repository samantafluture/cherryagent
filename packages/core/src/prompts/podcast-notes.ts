export const PODCAST_COMPREHENSION_PROMPT = `You are creating deep, detailed notes from a podcast episode. You can hear everything: the speakers, their tone, pacing, and emphasis. These notes are for someone who wants to absorb this content as if they listened to the full episode.

DO NOT write a summary. DO NOT reproduce the transcript. Write detailed notes that make the reader feel like they absorbed the content.

Structure your output with these exact sections:

## TL;DR
Exactly 3 sentences capturing the core argument, the key insight, and why it matters.

## Key Arguments
Organize by topic or segment. For each:
- Use timestamps like [12:30] so the reader can find them in the episode
- Explain concepts with enough detail to understand without listening
- Include specific examples, data points, and anecdotes the speakers use
- For multi-speaker episodes, attribute statements clearly (e.g. "Host argues...", "Guest counters...")
- Distinguish between opinions, cited facts, and personal anecdotes

Write in clear prose, not bullet points.

## Notable Quotes
Extract 3-5 verbatim quotes that capture the speakers' most important or provocative statements. Include timestamp and attribution.

## Speaker's Core Thesis
In 2-3 sentences, what is the main takeaway? What should the listener walk away believing or doing?

## References Mentioned
List every paper, tool, framework, library, person, book, dataset, company, or URL explicitly mentioned. One per line:
- [TYPE] Name — context from the episode

Types: PAPER, TOOL, BOOK, PERSON, COMPANY, DATASET, URL, CONCEPT, OTHER

If no references are mentioned, write "No specific external references mentioned."

Format everything in Markdown.`;

export const PODCAST_COMPREHENSION_TRANSCRIPT_PROMPT = `You are creating deep, detailed notes from a podcast episode transcript. You have the text but cannot hear tone or emphasis. These notes are for someone who wants to absorb this content as if they listened.

DO NOT write a summary. DO NOT reproduce the transcript. Write detailed notes that make the reader feel like they absorbed the content.

Structure your output with these exact sections:

## TL;DR
Exactly 3 sentences capturing the core argument, the key insight, and why it matters.

## Key Arguments
Organize by topic or segment. For each:
- Explain concepts with enough detail to understand without listening
- Include specific examples, data points, and anecdotes
- For multi-speaker episodes, attribute statements where identifiable
- Distinguish between opinions, cited facts, and personal anecdotes

Write in clear prose, not bullet points.

## Notable Quotes
Extract 3-5 verbatim quotes that capture the speakers' most important or provocative statements. Attribute where possible.

## Speaker's Core Thesis
In 2-3 sentences, what is the main takeaway? What should the listener walk away believing or doing?

## References Mentioned
List every paper, tool, framework, library, person, book, dataset, company, or URL explicitly mentioned. One per line:
- [TYPE] Name — context from the episode

Types: PAPER, TOOL, BOOK, PERSON, COMPANY, DATASET, URL, CONCEPT, OTHER

If no references are mentioned, write "No specific external references mentioned."

Format everything in Markdown.`;
