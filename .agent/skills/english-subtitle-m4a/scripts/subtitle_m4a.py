#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import requests
from mutagen.mp4 import MP4


DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "whisper-large-v3-turbo"
MAX_API_BYTES = 25 * 1024 * 1024
SAFE_API_BYTES = 24 * 1024 * 1024


def redact(value: str) -> str:
    out = value
    for key in ("GROQ_API_KEY", "TELEGRAM_BOT_TOKEN"):
        secret = os.environ.get(key)
        if secret:
            out = out.replace(secret, "<redacted>")
    return out


def resolve_api_key() -> str:
    return os.getenv("GROQ_API_KEY", "").strip()


def resolve_groq_base_url() -> str:
    return (
        os.getenv("GROQ_BASE_URL")
        or os.getenv("GROQ_API_BASE")
        or os.getenv("GROQ_OPENAI_BASE_URL")
        or DEFAULT_GROQ_BASE_URL
    ).strip().rstrip("/")


def resolve_model(raw: str | None) -> str:
    value = (raw or "").strip()
    if value:
        return value
    return (os.getenv("ADS_GROQ_WHISPER_MODEL") or os.getenv("GROQ_WHISPER_MODEL") or DEFAULT_MODEL).strip()


def find_parent_binary(start: Path, relative: str) -> str | None:
    for parent in [start, *start.parents]:
        candidate = parent / relative
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def resolve_ffmpeg() -> str | None:
    configured = os.getenv("FFMPEG_BINARY", "").strip()
    if configured and Path(configured).exists():
        return configured

    path_ffmpeg = shutil.which("ffmpeg")
    if path_ffmpeg:
        return path_ffmpeg

    script_dir = Path(__file__).resolve().parent
    for start in (script_dir, Path.cwd().resolve()):
        found = find_parent_binary(start, "node_modules/ffmpeg-static/ffmpeg")
        if found:
            return found

    node = shutil.which("node")
    if node:
        for cwd in (Path.cwd().resolve(), script_dir):
            try:
                result = subprocess.run(
                    [node, "-e", "process.stdout.write(require('ffmpeg-static') || '')"],
                    cwd=str(cwd),
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                candidate = result.stdout.strip()
                if candidate and Path(candidate).exists():
                    return candidate
            except Exception:
                pass

    return None


def run_ffmpeg(args: list[str]) -> None:
    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(
            "ffmpeg not found. Install ffmpeg, set FFMPEG_BINARY, or install the project dependency ffmpeg-static."
        )
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", *args], check=True)


def guess_content_type(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def prepare_api_audio(audio_path: Path) -> tuple[Path, Path | None]:
    if audio_path.stat().st_size <= SAFE_API_BYTES:
        return audio_path, None

    temp_dir = Path(tempfile.mkdtemp(prefix="subtitle-m4a-api-"))
    compressed = temp_dir / f"{audio_path.stem}-api.mp3"
    run_ffmpeg(["-y", "-i", str(audio_path), "-vn", "-ac", "1", "-b:a", "64k", str(compressed)])
    if compressed.stat().st_size > MAX_API_BYTES:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise RuntimeError("compressed audio is still over the 25MB API limit")
    return compressed, temp_dir


def transcribe_words(audio_path: Path, api_key: str, model: str) -> dict[str, Any]:
    endpoint = f"{resolve_groq_base_url()}/audio/transcriptions"
    with audio_path.open("rb") as file:
        response = requests.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (audio_path.name, file, guess_content_type(audio_path))},
            data={
                "model": model,
                "response_format": "verbose_json",
                "language": "en",
                "timestamp_granularities[]": "word",
            },
            timeout=240,
        )
    if response.status_code >= 400:
        body = redact(response.text[:1000])
        raise RuntimeError(f"Groq transcription failed: HTTP {response.status_code}: {body}")
    return response.json()


def sentence_boundary(token: str) -> bool:
    return re.search(r"[.!?][\"')\]]*$", token.strip()) is not None


def clean_sentence(tokens: list[str]) -> str:
    text = " ".join(token.strip() for token in tokens if token.strip())
    text = re.sub(r"\s+([,.;:!?%])", r"\1", text)
    text = re.sub(r"([([{])\s+", r"\1", text)
    text = re.sub(r"\s+([)\]}])", r"\1", text)
    text = re.sub(r"\s+'\s*", "'", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def words_to_sentences(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sentences: list[dict[str, Any]] = []
    current: list[str] = []
    start: float | None = None
    end = 0.0

    for item in words:
        word = str(item.get("word", "")).strip()
        if not word:
            continue
        word_start = float(item.get("start", end))
        word_end = float(item.get("end", word_start))
        if start is None:
            start = word_start
        end = word_end
        current.append(word)
        if sentence_boundary(word):
            text = clean_sentence(current)
            if text:
                sentences.append({"start": start, "end": end, "text": text})
            current = []
            start = None

    if current and start is not None:
        text = clean_sentence(current)
        if text:
            sentences.append({"start": start, "end": end, "text": text})
    return sentences


def segments_to_sentences(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sentences: list[dict[str, Any]] = []
    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", start))
        sentences.append({"start": start, "end": end, "text": text})
    return sentences


def timestamp(seconds: float) -> str:
    seconds = max(0.0, seconds)
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    return f"{minutes:02d}:{rest:05.2f}"


def make_lrc(sentences: list[dict[str, Any]]) -> str:
    return "\n".join(f"[{timestamp(sentence['start'])}] {sentence['text']}" for sentence in sentences) + "\n"


def output_stem(input_path: Path, suffix: str) -> str:
    stem = input_path.stem
    match = re.match(r"^\d+", stem)
    if match:
        stem = str(int(match.group(0))) + stem[match.end() :]
    return f"{stem}{suffix}"


def embed_lyrics_m4a(path: Path, lrc_text: str) -> None:
    audio = MP4(path)
    audio["\xa9lyr"] = [lrc_text]
    audio.save()


def export_m4a(input_path: Path, output_path: Path, lrc_text: str) -> None:
    if input_path.suffix.lower() in {".m4a", ".mp4"}:
        shutil.copy2(input_path, output_path)
    else:
        run_ffmpeg(["-y", "-i", str(input_path), "-vn", "-c:a", "aac", "-b:a", "160k", str(output_path)])
    embed_lyrics_m4a(output_path, lrc_text)


def send_telegram_document(path: Path, caption: str) -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = (os.getenv("ADS_TELEGRAM_CHAT_ID") or os.getenv("TELEGRAM_CHAT_ID") or "").strip()
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not set")
    if not chat_id:
        raise RuntimeError("ADS_TELEGRAM_CHAT_ID is not set")

    url = f"https://api.telegram.org/bot{token}/sendDocument"
    with path.open("rb") as file:
        response = requests.post(
            url,
            data={"chat_id": chat_id, "caption": caption[:1024]},
            files={"document": (path.name, file, "audio/mp4")},
            timeout=240,
        )
    if response.status_code >= 400:
        body = redact(response.text[:1000])
        raise RuntimeError(f"Telegram sendDocument failed: HTTP {response.status_code}: {body}")


def write_sidecars(output_path: Path, lrc_text: str, sentences: list[dict[str, Any]]) -> tuple[Path, Path]:
    lrc_path = output_path.with_suffix(".lrc")
    json_path = output_path.with_suffix(".json")
    lrc_path.write_text(lrc_text, encoding="utf-8")
    json_path.write_text(json.dumps(sentences, ensure_ascii=False, indent=2), encoding="utf-8")
    return lrc_path, json_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Create an M4A with embedded sentence-level English subtitles.")
    parser.add_argument("--input", required=True, help="Input MP3/M4A/audio file path")
    parser.add_argument("--output-dir", default="", help="Output directory, defaults to a temporary state directory")
    parser.add_argument("--suffix", default="-sub", help="Output filename suffix")
    parser.add_argument("--model", default="", help="Groq Whisper model")
    parser.add_argument("--send-telegram", action="store_true", help="Send generated M4A to current Telegram chat")
    parser.add_argument("--caption", default="已生成带逐句字幕的 M4A。", help="Telegram caption")
    parser.add_argument("--keep-output", action="store_true", help="Keep output files even after successful Telegram send")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.is_file():
        print(f"error: input file not found: {input_path}", file=sys.stderr)
        return 2

    api_key = resolve_api_key()
    if not api_key:
        print("error: GROQ_API_KEY is not set. Set it in the ads-tg service environment yourself.", file=sys.stderr)
        return 2

    if args.output_dir:
        output_dir = Path(args.output_dir).expanduser().resolve()
    else:
        base = os.getenv("ADS_STATE_DIR") or tempfile.gettempdir()
        output_dir = Path(base) / "temp" / "english-subtitle-m4a"
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / f"{output_stem(input_path, args.suffix)}.m4a"
    api_audio, temp_dir = prepare_api_audio(input_path)
    try:
        result = transcribe_words(api_audio, api_key, resolve_model(args.model))
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)

    words = result.get("words") or []
    sentences = words_to_sentences(words)
    if not sentences:
        sentences = segments_to_sentences(result.get("segments") or [])
    if not sentences:
        print("error: no word or segment timestamps returned by transcription API", file=sys.stderr)
        return 2

    lrc_text = make_lrc(sentences)
    export_m4a(input_path, output_path, lrc_text)
    lrc_path, json_path = write_sidecars(output_path, lrc_text, sentences)

    sent = False
    if args.send_telegram:
        send_telegram_document(output_path, args.caption)
        sent = True

    print(json.dumps(
        {
            "ok": True,
            "sent_telegram": sent,
            "sentences": len(sentences),
            "m4a": str(output_path),
            "lrc": str(lrc_path),
            "json": str(json_path),
        },
        ensure_ascii=False,
    ))

    if sent and not args.keep_output:
        for path in (output_path, lrc_path, json_path):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {redact(str(exc))}", file=sys.stderr)
        raise SystemExit(1)
