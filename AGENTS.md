# CherryAgent Guide

Read `CLAUDE.md` and `.claude/tasks.md` before changing code.

Focus:

- Telegram-driven personal automation
- Cost-aware LLM routing
- Fitbit, task, and media workflows

Rules:

- Keep model routing and spend caps intact
- No direct LLM calls outside the core abstraction
- Use Fastify logger, not `console.log`
