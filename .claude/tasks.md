# Tasks

## Fix YouTube Cookie Error

**Status:** Open

yt-dlp is failing with a bot detection / authentication error when downloading YouTube videos.

**Error log:**

```
Failed to process video:
Command failed: yt-dlp --js-runtimes node --cookies /home/node/.cherryagent/media/.cookies.tmp.txt -f ba/b -x --audio-format mp3 --audio-quality 128K --no-playlist --no-warnings -o /home/node/.cherryagent/media/if_i_started_youtube_from_scratch_in_2026_i_d_do_this_1773582862369.mp3 https://youtu.be/rdT3XBZlnHA?si=lFVyThV1WhqmacF1
ERROR: [youtube] rdT3XBZlnHA: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies. Also see  https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies  for tips on effectively exporting YouTube cookies
```

**References:**
- https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp
- https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies

---

## Create Agent Workflow to Update tasks.md

**Status:** Open

Build a new agent workflow that can update the `tasks.md` file of a given project via its GitHub repo. This agent should be able to add, update, and manage tasks programmatically.
