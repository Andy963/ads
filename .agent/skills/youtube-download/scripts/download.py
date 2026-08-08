#!/usr/bin/env python3
"""Download a single public YouTube item and optionally deliver it to Telegram."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


SKILL_DIR = Path(__file__).resolve().parent.parent
ADS_ROOT = SKILL_DIR.parents[2]
DEFAULT_DOWNLOAD_DIR = Path("/home/andy/repos/downloads")
DEFAULT_OUTPUT_TEMPLATE = "%(title).180B [%(id)s].%(ext)s"
DEFAULT_VIDEO_FORMAT = (
    "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/"
    "best[height<=1080][ext=mp4]/best[height<=1080]"
)
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "www.youtu.be",
}


def normalize_youtube_url(value: str) -> str:
    url = value.strip()
    if not url:
        raise ValueError("url is empty")

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("url must start with http:// or https://")

    if parsed.netloc.lower() not in YOUTUBE_HOSTS:
        raise ValueError("only youtube.com and youtu.be links are allowed")
    if not parsed.path and parsed.netloc.lower() != "youtu.be":
        raise ValueError("youtube url path is empty")
    return url


def resolve_output_dir(explicit: str) -> Path:
    candidate = explicit.strip() or os.getenv("ADS_YOUTUBE_DOWNLOAD_DIR", "").strip()
    if candidate:
        output_dir = Path(candidate).expanduser()
        # A relative path would land under the service cwd (the repos tree);
        # anchor it to the shared download directory instead.
        if not output_dir.is_absolute():
            output_dir = DEFAULT_DOWNLOAD_DIR / output_dir
    else:
        output_dir = DEFAULT_DOWNLOAD_DIR
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def resolve_ffmpeg() -> str | None:
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg

    try:
        completed = subprocess.run(
            ["node", "-e", "process.stdout.write(require('ffmpeg-static') || '')"],
            cwd=ADS_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None

    candidate = completed.stdout.strip()
    return candidate if completed.returncode == 0 and Path(candidate).is_file() else None


def build_download_command(
    *,
    url: str,
    output_dir: Path,
    media_type: str,
    audio_format: str,
    ffmpeg: str | None,
) -> list[str]:
    downloader = shutil.which("yt-dlp")
    if not downloader:
        raise RuntimeError("yt-dlp is not installed or is not on PATH")

    command = [
        downloader,
        "--quiet",
        "--no-warnings",
        "--no-playlist",
        "--restrict-filenames",
        "--output",
        str(output_dir / DEFAULT_OUTPUT_TEMPLATE),
        "--print",
        "after_move:filepath",
    ]
    if ffmpeg:
        command.extend(["--ffmpeg-location", ffmpeg])

    if media_type == "audio":
        command.extend(["--format", "bestaudio[ext=m4a]/bestaudio"])
        if audio_format:
            command.extend(["--extract-audio", "--audio-format", audio_format])
    else:
        command.extend(["--format", DEFAULT_VIDEO_FORMAT])

    command.append(url)
    return command


def run_download(command: list[str], output_dir: Path) -> list[Path]:
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(detail or f"yt-dlp exited with code {completed.returncode}")

    files = [
        Path(line).resolve()
        for line in completed.stdout.splitlines()
        if line.strip() and Path(line.strip()).is_file()
    ]
    if not files:
        raise RuntimeError(f"yt-dlp finished without reporting an output file in {output_dir}")
    return files


def telegram_api_url(token: str, method: str) -> str:
    return f"https://api.telegram.org/bot{token}/{method}"


def encode_multipart(fields: dict[str, str], file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = f"----ads-ytd-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    def add(value: str) -> None:
        chunks.append(value.encode("utf-8"))

    for key, value in fields.items():
        add(f"--{boundary}\r\n")
        add(f'Content-Disposition: form-data; name="{key}"\r\n\r\n')
        add(f"{value}\r\n")

    mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    add(f"--{boundary}\r\n")
    add(
        f'Content-Disposition: form-data; name="{file_field}"; '
        f'filename="{file_path.name}"\r\n'
    )
    add(f"Content-Type: {mime_type}\r\n\r\n")
    chunks.append(file_path.read_bytes())
    add("\r\n")
    add(f"--{boundary}--\r\n")
    return b"".join(chunks), boundary


def send_telegram_file(file_path: Path, media_type: str, caption: str) -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = (os.getenv("ADS_TELEGRAM_CHAT_ID") or os.getenv("TELEGRAM_CHAT_ID") or "").strip()
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not set")
    if not chat_id:
        raise RuntimeError("ADS_TELEGRAM_CHAT_ID is not set")

    method, field = ("sendAudio", "audio") if media_type == "audio" else ("sendVideo", "video")
    body, boundary = encode_multipart(
        {"chat_id": chat_id, "caption": caption[:1024]},
        field,
        file_path,
    )
    request = Request(
        telegram_api_url(token, method),
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=300) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"Telegram {method} failed: HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError(f"Telegram {method} failed: {error.reason}") from error

    if not payload.get("ok"):
        raise RuntimeError(f"Telegram {method} rejected the file")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download one public YouTube video or audio file.")
    parser.add_argument("--url", required=True, help="YouTube video URL")
    parser.add_argument("--media-type", choices=["video", "audio"], default="video")
    parser.add_argument("--audio-format", default="", help="Optional audio conversion format, e.g. mp3")
    parser.add_argument("--output-dir", default="", help="Destination directory")
    parser.add_argument("--send-telegram", action="store_true", help="Send output to the current Telegram chat")
    parser.add_argument("--caption", default="Downloaded via ADS", help="Telegram caption")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        url = normalize_youtube_url(args.url)
        output_dir = resolve_output_dir(args.output_dir)
        ffmpeg = resolve_ffmpeg()
        if args.media_type == "video" and not ffmpeg:
            raise RuntimeError("ffmpeg is required to merge video and audio streams")
        if args.media_type == "audio" and args.audio_format and not ffmpeg:
            raise RuntimeError("ffmpeg is required for audio format conversion")

        files = run_download(
            build_download_command(
                url=url,
                output_dir=output_dir,
                media_type=args.media_type,
                audio_format=args.audio_format.strip(),
                ffmpeg=ffmpeg,
            ),
            output_dir,
        )
        if args.send_telegram:
            for file_path in files:
                send_telegram_file(file_path, args.media_type, args.caption)
    except (RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print(
        json.dumps(
            {
                "media_type": args.media_type,
                "output_dir": str(output_dir),
                "files": [str(file_path) for file_path in files],
                "telegram_sent": bool(args.send_telegram),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
