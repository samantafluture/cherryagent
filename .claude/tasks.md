# Project: CherryAgent

> Last synced to repo: 2026-04-04T23:10:01+00:00
> Last agent update: 2026-04-05

## Active Sprint

### P0 — Must do now
### P1 — Should do this week

- [x] Enhance /yt notes: always use Gemini video mode (not transcript), add personal insights pipeline — after delivering standard notes, auto-create backlog task for deep analysis that cross-references video with Sam's projects/context and produces actionable insights doc via Telegram interview `[L]` #feature ✅ 2026-04-04
- [x] Harden deploy.sh: auto-checkout main and delete stale .git lock files before pull to prevent CI failures from leftover claude/* branches `[S]` #devops ✅ 2026-04-04
### P2 — Nice to have

## Blocked

## Completed (recent)
- [x] Bug: /yt command fails — YouTube requires cookie auth for yt-dlp downloads `[M]` #bug ✅ 2026-04-04
- [x] Export fresh YouTube cookies.txt from desktop Chrome + set YTDLP_COOKIES_FILE=/app/cookies.txt in .env + restart container 👤 manual `[S]` #bug ✅ 2026-04-04
- [x] Test cherry-sync GitHub Issues integration `[S]` #devops ✅ 2026-04-03

## Notes
- Check CLAUDE.md for architectural decisions before starting work
