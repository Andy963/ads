---
name: english-subtitle-m4a
description: "Convert an uploaded English MP3/M4A audio file into an M4A with embedded sentence-level LRC subtitles, then send it back to the current Telegram chat. Use for 英语精听, 单句复读, 加字幕, 内嵌歌词, 转 m4a 字幕."
requires:
  env: [GROQ_API_KEY, TELEGRAM_BOT_TOKEN]
  tools: [bash, python3]
channels: [telegram]
allowed-tools: [bash]
---

# English Subtitle M4A

## What this does

Use this skill when a Telegram user uploads an English audio file and asks to add sentence-level subtitles or create a listening/repeat file.

The script:
- Sends the audio to Groq Whisper with word-level timestamps.
- Rebuilds timestamps into one LRC line per complete English sentence.
- Converts the source audio to `.m4a`.
- Embeds the LRC text into the M4A `©lyr` tag.
- Sends the resulting `.m4a` back to the current Telegram chat.

## Required environment

Do not ask the user for secrets in chat.

Required:
- `GROQ_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `ADS_TELEGRAM_CHAT_ID`, normally injected by `ads-tg` during Telegram sessions

Audio conversion requires one of:
- `ffmpeg` on `PATH`
- `FFMPEG_BINARY=/absolute/path/to/ffmpeg`
- project dependency `ffmpeg-static`

## Telegram workflow

When `ads-tg` receives an audio message or document, it saves the file locally and passes a local file path in the prompt, usually like:

```text
用户上传的文件:
- name.mp3: /path/to/downloaded/file.mp3
```

Run:

```bash
python3 ${SKILL_DIR}/scripts/subtitle_m4a.py \
  --input "/path/to/downloaded/file.mp3" \
  --send-telegram
```

If a caption is useful:

```bash
python3 ${SKILL_DIR}/scripts/subtitle_m4a.py \
  --input "/path/to/downloaded/file.mp3" \
  --send-telegram \
  --caption "已生成带逐句字幕的 M4A"
```

After the command succeeds, reply briefly that the M4A has been sent. Do not paste the transcript unless the user explicitly asks.
The generated audio output must be `.m4a` only. Do not generate or send an `.mp3`.

## Local-only workflow

For testing without Telegram:

```bash
python3 ${SKILL_DIR}/scripts/subtitle_m4a.py \
  --input "/path/to/audio.mp3" \
  --output-dir /tmp/subtitle-m4a
```

The command prints the output path and sentence count.

## Privacy rules

- Never print API keys, bot tokens, `.env` contents, or Telegram file URLs.
- If an API key is missing, tell the user to configure the environment themselves.
- Do not edit `.env`, systemd units, shell profiles, or secret stores without explicit user permission.
