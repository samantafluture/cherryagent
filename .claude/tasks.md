# Project: CherryAgent

> Last synced to repo: 2026-05-01T11:20:01+00:00
> Last agent update: 2026-04-06

## Active Sprint

### P0 — Must do now
(none)

### P1 — Should do this week
- [x] Add notes/body support to CherryTask sync so detailed context maps to GitHub Issue body instead of title (256 char limit) `[M]` #cherrytask ✅ 2026-04-25
- [x] Fix EACCES permission errors on .claude/tasks.md across all VPS projects caused by container user (node, UID 1000) vs host user (sam) mismatch `[S]` #devops ✅ 2026-04-25

### P2 — Nice to have

## Blocked

## Completed (recent)

## Notes
- CherryTask sync currently uses the full task checkbox line as the GitHub Issue title. Titles over 256 chars or containing backticks cause sync failures. Need a parsing format (e.g. indented lines below a task, or a delimiter) that maps to the issue body while keeping the first line as the title.
- The EACCES bug affects any project where the Dockerfile runs as node (UID 1000) but mounted volume files are owned by sam on the host. Workaround is manual chown -R 1000:1000 on the project dir, but this breaks on every deploy/restart. Fix should be in Dockerfile user config, entrypoint script, or docker-compose volume permissions.
