---
name: youtube-download
description: "Download one YouTube video or audio with yt-dlp. In ADS-TG, send the resulting file to the current Telegram chat. Use for 下载 YouTube 视频/音频, YouTube download, or yt-dlp."
version: 1
provides: [youtube.download, media.download]
priority: 300
platforms: [linux]
required_env:
  - name: TELEGRAM_BOT_TOKEN
    prompt: Telegram delivery requires the configured ads-tg bot token.
    secret: true
triggers:
  keywords: [youtube, youtu.be, yt-dlp, 下载视频, 下载音频, 下载YouTube]
  intents: [youtube.download]
entrypoints:
  - cmd: python3
    script: scripts/download.py
    args_template: ["--url", "{url}", "--media-type", "{media_type}"]
    description: Download a single YouTube video or audio file.
channels: [telegram, web, cli]
allowed-tools: [bash]
---

# YouTube Download

Download a single YouTube video or audio file with `yt-dlp`.

## Rules

- Accept only `youtube.com` or `youtu.be` links.
- Do not download playlists unless the user explicitly asks for one. This
  skill defaults to one item and does not expose playlist mode.
- Default to `video`; use `audio` only when the user explicitly asks for audio
  only.
- Video is capped at 1080p and includes audio. The script uses ADS's
  `ffmpeg-static` dependency when a system `ffmpeg` is unavailable.
- Do not use browser cookies, login credentials, or private content.
- Downloads always land in `/home/andy/repos/downloads` (symlink to
  `/opt/alist-stack/downloads`). Never create download directories inside the
  repository tree. See "Output location" below.

## ADS-TG workflow

When the request comes from Telegram, ADS injects `ADS_TELEGRAM_CHAT_ID`.
Run the download with `--send-telegram`; the script directly sends the file
back to that chat and prints a concise JSON result.

### Direct entrypoint, no search

When this skill is automatically loaded, its enclosing `<skill>` tag has a
`location` attribute that points to this exact `SKILL.md`. The script is always
at:

```text
<dirname of location>/scripts/download.py
```

Use that path directly. `SKILL_DIR` is **not** a shell environment variable in
ADS-TG. Do not run `/ads.skill.list`, `/ads.skill.load`, `find`, `locate`, or a
workspace-wide file search to discover this script or the downloaded media.

For example, if the injected location is
`/home/andy/.local/share/ads-runtime/current/dist/.agent/skills/youtube-download/SKILL.md`,
run:

```bash
python3 /home/andy/.local/share/ads-runtime/current/dist/.agent/skills/youtube-download/scripts/download.py \
  --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
  --media-type video \
  --send-telegram
```

For audio only:

```bash
python3 /home/andy/.local/share/ads-runtime/current/dist/.agent/skills/youtube-download/scripts/download.py \
  --url "https://youtu.be/dQw4w9WgXcQ" \
  --media-type audio \
  --audio-format mp3 \
  --send-telegram
```

After a successful Telegram delivery, respond briefly that the requested file
has been sent. Never reveal the bot token or Telegram API response body.

### Output contract

The command prints one JSON object. Its `files` array contains the authoritative
absolute paths of final outputs, and `telegram_sent: true` confirms that ADS-TG
has already sent those exact files. Treat this JSON as final:

- Do not search the filesystem for another matching file.
- Do not upload or send the same file again.
- If `telegram_sent` is true, reply only with a concise confirmation.

## Output location

All downloads — with or without `--send-telegram` — are written to the shared
alist download directory:

```text
/home/andy/repos/downloads   ->   /opt/alist-stack/downloads
```

Never write downloads under the repository tree (no `.ads/youtube-downloads`,
no scratch directories inside `~/repos`).

Overrides, in priority order:

1. `--output-dir /path/to/output`
2. `ADS_YOUTUBE_DOWNLOAD_DIR=/path/to/output`
3. the default above

Both overrides must be absolute paths. A relative path is anchored to the
shared download directory, never to the process working directory (which is
`/home/andy/repos`).

```bash
python3 /absolute/path/from-the-injected-skill-location/scripts/download.py \
  --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
  --media-type video \
  --output-dir "/path/to/output"
```

Files are kept after a Telegram delivery; the script never deletes them.

## Requirements and failure handling

- `yt-dlp` must be installed and available on `PATH`.
- Audio conversion and video/audio merging require either system `ffmpeg` or
  ADS's installed `ffmpeg-static`.
- If Telegram rejects a file, report the concise error and leave the local
  download path in the script JSON for operator diagnosis. Do not retry
  automatically.
