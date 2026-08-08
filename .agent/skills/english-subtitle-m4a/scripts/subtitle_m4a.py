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
import time
from pathlib import Path
from typing import Any

import requests
from mutagen.mp4 import MP4


DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "whisper-large-v3-turbo"
DEFAULT_TRANSLATION_MODEL = "qwen/qwen3.6-27b"
MAX_API_BYTES = 25 * 1024 * 1024
SAFE_API_BYTES = 24 * 1024 * 1024
DEFAULT_MAX_WORDS = 18
DEFAULT_MAX_CHARS = 96
DEFAULT_MAX_SECONDS = 9.0
DEFAULT_PAUSE_THRESHOLD = 0.75
MIN_SPLIT_WORDS = 4
TRANSLATION_BATCH_ITEMS = 12
TRANSLATION_BATCH_CHARS = 1100
TRANSLATION_RETRIES = 6
CHINESE_CHARACTER_RE = re.compile(r"[\u3400-\u9fff]")
UNEXPECTED_SCRIPT_RE = re.compile(r"[\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af]")
RATE_LIMIT_WAIT_RE = re.compile(r"try again in ([0-9.]+)s", re.IGNORECASE)


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


def resolve_translation_model(raw: str | None) -> str:
    value = (raw or "").strip()
    if value:
        return value
    return (
        os.getenv("ADS_GROQ_TRANSLATION_MODEL")
        or os.getenv("GROQ_TRANSLATION_MODEL")
        or DEFAULT_TRANSLATION_MODEL
    ).strip()


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


def normalize_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    previous_end = 0.0
    for item in words:
        text = str(item.get("word", "")).strip()
        if not text:
            continue
        start = float(item.get("start", previous_end))
        end = max(start, float(item.get("end", start)))
        normalized.append({"word": text, "start": start, "end": end})
        previous_end = end
    return normalized


def words_text(words: list[dict[str, Any]]) -> str:
    return clean_sentence([str(item["word"]) for item in words])


def words_duration(words: list[dict[str, Any]]) -> float:
    if not words:
        return 0.0
    return max(0.0, float(words[-1]["end"]) - float(words[0]["start"]))


def words_are_long(
    words: list[dict[str, Any]],
    max_words: int,
    max_chars: int,
    max_seconds: float,
) -> bool:
    return (
        len(words) > max_words
        or len(words_text(words)) > max_chars
        or words_duration(words) > max_seconds
    )


def boundary_score(
    words: list[dict[str, Any]],
    index: int,
    target: int,
    pause_threshold: float,
) -> float:
    previous = str(words[index - 1]["word"]).strip()
    following = str(words[index]["word"]).strip().lower()
    gap = max(0.0, float(words[index]["start"]) - float(words[index - 1]["end"]))
    score = -abs(index - target) * 3.0

    if sentence_boundary(previous):
        score += 120.0
    elif re.search(r"[,;:][\"')\]]*$", previous):
        score += 75.0
    elif re.search(r"(?:--+|[—–])[\"')\]]*$", previous):
        score += 65.0

    if gap >= pause_threshold:
        score += 85.0 + min(gap, 2.0) * 10.0
    elif gap >= 0.4:
        score += 35.0

    if following in {
        "and",
        "but",
        "or",
        "so",
        "because",
        "while",
        "when",
        "if",
        "until",
        "then",
        "which",
        "who",
    }:
        score += 25.0
    return score


def split_long_words(
    words: list[dict[str, Any]],
    max_words: int,
    max_chars: int,
    max_seconds: float,
    pause_threshold: float,
) -> list[list[dict[str, Any]]]:
    remaining = words
    chunks: list[list[dict[str, Any]]] = []

    while (
        words_are_long(remaining, max_words, max_chars, max_seconds)
        and len(remaining) >= MIN_SPLIT_WORDS * 2
    ):
        fitting = MIN_SPLIT_WORDS
        for index in range(MIN_SPLIT_WORDS, len(remaining)):
            if words_are_long(remaining[: index + 1], max_words, max_chars, max_seconds):
                break
            fitting = index + 1

        target = fitting
        if len(remaining) - target < MIN_SPLIT_WORDS:
            target = max(MIN_SPLIT_WORDS, len(remaining) // 2)

        lower = MIN_SPLIT_WORDS
        upper = min(len(remaining) - MIN_SPLIT_WORDS, max(target + 4, lower))
        if upper < lower:
            break

        split_at = max(
            range(lower, upper + 1),
            key=lambda index: boundary_score(remaining, index, target, pause_threshold),
        )
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:]

    if remaining:
        chunks.append(remaining)
    return chunks


def sentence_from_words(words: list[dict[str, Any]]) -> dict[str, Any] | None:
    text = words_text(words)
    if not text:
        return None
    return {
        "start": float(words[0]["start"]),
        "end": float(words[-1]["end"]),
        "text": text,
    }


def words_to_sentences(
    words: list[dict[str, Any]],
    max_words: int = DEFAULT_MAX_WORDS,
    max_chars: int = DEFAULT_MAX_CHARS,
    max_seconds: float = DEFAULT_MAX_SECONDS,
    pause_threshold: float = DEFAULT_PAUSE_THRESHOLD,
) -> list[dict[str, Any]]:
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []

    for item in normalize_words(words):
        if current:
            gap = max(0.0, float(item["start"]) - float(current[-1]["end"]))
            if gap >= pause_threshold and len(current) >= 2:
                groups.append(current)
                current = []

        current.append(item)
        if sentence_boundary(str(item["word"])):
            groups.append(current)
            current = []

    if current:
        groups.append(current)

    sentences: list[dict[str, Any]] = []
    for group in groups:
        for chunk in split_long_words(group, max_words, max_chars, max_seconds, pause_threshold):
            sentence = sentence_from_words(chunk)
            if sentence:
                sentences.append(sentence)
    return sentences


def segments_to_sentences(
    segments: list[dict[str, Any]],
    max_words: int = DEFAULT_MAX_WORDS,
    max_chars: int = DEFAULT_MAX_CHARS,
    max_seconds: float = DEFAULT_MAX_SECONDS,
    pause_threshold: float = DEFAULT_PAUSE_THRESHOLD,
) -> list[dict[str, Any]]:
    estimated_words: list[dict[str, Any]] = []
    for segment in segments:
        tokens = re.findall(r"\S+", str(segment.get("text", "")).strip())
        if not tokens:
            continue
        start = float(segment.get("start", 0.0))
        end = max(start, float(segment.get("end", start)))
        weights = [max(1, len(re.sub(r"\W", "", token))) for token in tokens]
        total_weight = sum(weights)
        elapsed_weight = 0
        for token, weight in zip(tokens, weights, strict=True):
            word_start = start + (end - start) * elapsed_weight / total_weight
            elapsed_weight += weight
            word_end = start + (end - start) * elapsed_weight / total_weight
            estimated_words.append({"word": token, "start": word_start, "end": word_end})
    return words_to_sentences(
        estimated_words,
        max_words=max_words,
        max_chars=max_chars,
        max_seconds=max_seconds,
        pause_threshold=pause_threshold,
    )


def timestamp(seconds: float) -> str:
    seconds = max(0.0, seconds)
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    return f"{minutes:02d}:{rest:05.2f}"


def extract_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("translation response did not contain a JSON object")
    value = json.loads(text[start : end + 1])
    if not isinstance(value, dict):
        raise RuntimeError("translation response JSON must be an object")
    return value


def parse_translation_response(content: str, expected_ids: list[int]) -> dict[int, str]:
    payload = extract_json_object(content)
    items = payload.get("translations")
    if not isinstance(items, list):
        raise RuntimeError("translation response must contain a translations array")

    translations: dict[int, str] = {}
    received_ids: list[int] = []
    invalid_script_ids: list[int] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            item_id = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        value = item.get("chinese") or item.get("translation")
        if not isinstance(value, str):
            continue
        text = re.sub(r"\s+", " ", value).strip()
        if text:
            received_ids.append(item_id)
            translations[item_id] = text

            if not CHINESE_CHARACTER_RE.search(text) or UNEXPECTED_SCRIPT_RE.search(text):
                invalid_script_ids.append(item_id)

    if received_ids != expected_ids:
        raise RuntimeError(
            f"translation response ids were reordered, duplicated, or unexpected: {received_ids}"
        )

    missing = [item_id for item_id in expected_ids if item_id not in translations]
    if missing:
        raise RuntimeError(f"translation response omitted sentence ids: {missing}")
    if invalid_script_ids:
        raise RuntimeError(
            f"translation response was not valid Simplified Chinese for sentence ids: {invalid_script_ids}"
        )
    return translations


def request_translation_batch(
    batch: list[tuple[int, str]],
    api_key: str,
    model: str,
) -> dict[int, str]:
    endpoint = f"{resolve_groq_base_url()}/chat/completions"
    expected_ids = [item_id for item_id, _ in batch]
    request_items = [{"id": item_id, "english": text} for item_id, text in batch]
    payload = {
        "model": model,
        "temperature": 0.0,
        "max_completion_tokens": 2048,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "Translate contiguous English children's-story subtitle items into idiomatic "
                    "Simplified Chinese. Use the full batch as story context, especially for dialogue, "
                    "pronouns, jokes, and phrases about eating. Translate common animal names and actions "
                    "instead of transliterating them. Use Chinese characters and standard Chinese "
                    "punctuation; never use Cyrillic, Japanese, or Korean script. Preserve meaning, tone, "
                    "and established proper names. Return only a JSON object with a translations array. "
                    "Each item must contain the original integer id and a chinese string. Keep a strict "
                    "one-to-one mapping in the original order: never merge, split, omit, duplicate, or "
                    "reorder items."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({"sentences": request_items}, ensure_ascii=False),
            },
        ],
    }
    if model.startswith("qwen/"):
        payload["reasoning_effort"] = "none"

    last_error: Exception | None = None
    for attempt in range(TRANSLATION_RETRIES):
        try:
            response = requests.post(
                endpoint,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
                timeout=180,
            )
            if response.status_code >= 400:
                body = redact(response.text[:1000])
                if response.status_code == 429 and attempt + 1 < TRANSLATION_RETRIES:
                    match = RATE_LIMIT_WAIT_RE.search(body)
                    wait_seconds = float(match.group(1)) + 1.0 if match else 20.0
                    time.sleep(min(max(wait_seconds, 5.0), 90.0))
                    continue
                raise RuntimeError(f"Groq translation failed: HTTP {response.status_code}: {body}")
            data = response.json()
            content = str(data["choices"][0]["message"]["content"])
            return parse_translation_response(content, expected_ids)
        except (KeyError, TypeError, ValueError, requests.RequestException, RuntimeError) as exc:
            last_error = exc
            if attempt + 1 < TRANSLATION_RETRIES:
                time.sleep(2**attempt)

    raise RuntimeError(f"translation failed after {TRANSLATION_RETRIES} attempts: {last_error}")


def translation_batches(sentences: list[dict[str, Any]]) -> list[list[tuple[int, str]]]:
    batches: list[list[tuple[int, str]]] = []
    current: list[tuple[int, str]] = []
    current_chars = 0
    for index, sentence in enumerate(sentences):
        text = str(sentence["text"])
        if current and (
            len(current) >= TRANSLATION_BATCH_ITEMS
            or current_chars + len(text) > TRANSLATION_BATCH_CHARS
        ):
            batches.append(current)
            current = []
            current_chars = 0
        current.append((index, text))
        current_chars += len(text)
    if current:
        batches.append(current)
    return batches


def translate_sentences(
    sentences: list[dict[str, Any]],
    api_key: str,
    model: str,
) -> list[dict[str, Any]]:
    translated = [dict(sentence) for sentence in sentences]
    for batch in translation_batches(sentences):
        values = request_translation_batch(batch, api_key, model)
        for item_id, _ in batch:
            translated[item_id]["translation"] = values[item_id]
    return translated


def make_bilingual_lrc(sentences: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for sentence in sentences:
        marker = f"[{timestamp(float(sentence['start']))}]"
        english = re.sub(r"\s+", " ", str(sentence["text"])).strip()
        chinese = re.sub(r"\s+", " ", str(sentence["translation"])).strip()
        lines.append(f"{marker} {english}")
        lines.append(f"{marker} {chinese}")
    return "\n".join(lines) + "\n"


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


def read_embedded_lyrics(path: Path) -> str:
    audio = MP4(path)
    values = (audio.tags or {}).get("\xa9lyr") or []
    return str(values[0]) if values else ""


def export_m4a(input_path: Path, output_path: Path, lrc_text: str) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.stem}-",
        suffix=".m4a",
        dir=output_path.parent,
    )
    os.close(handle)
    temporary_path = Path(temporary_name)
    try:
        if input_path.suffix.lower() in {".m4a", ".mp4"}:
            shutil.copy2(input_path, temporary_path)
        else:
            run_ffmpeg(
                [
                    "-y",
                    "-i",
                    str(input_path),
                    "-vn",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "160k",
                    str(temporary_path),
                ]
            )
        embed_lyrics_m4a(temporary_path, lrc_text)
        if read_embedded_lyrics(temporary_path) != lrc_text:
            raise RuntimeError("embedded lyrics verification failed")
        temporary_path.chmod(input_path.stat().st_mode & 0o666)
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


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


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create one M4A with embedded bilingual sentence subtitles."
    )
    parser.add_argument("--input", required=True, help="Input MP3/M4A/audio file path")
    parser.add_argument(
        "--output-dir",
        default="",
        help="Output directory, defaults to a temporary state directory",
    )
    parser.add_argument("--suffix", default="-sub-zh", help="Output filename suffix")
    parser.add_argument("--model", default="", help="Groq Whisper model")
    parser.add_argument(
        "--translation-model",
        default="",
        help="Groq chat model used for Simplified Chinese translation",
    )
    parser.add_argument(
        "--max-words",
        type=int,
        default=DEFAULT_MAX_WORDS,
        help="Maximum target words per subtitle item",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=DEFAULT_MAX_CHARS,
        help="Maximum target English characters per subtitle item",
    )
    parser.add_argument(
        "--max-seconds",
        type=float,
        default=DEFAULT_MAX_SECONDS,
        help="Maximum target duration per subtitle item",
    )
    parser.add_argument(
        "--pause-threshold",
        type=float,
        default=DEFAULT_PAUSE_THRESHOLD,
        help="Silence duration that can end a subtitle item",
    )
    parser.add_argument(
        "--send-telegram",
        action="store_true",
        help="Send generated M4A to current Telegram chat",
    )
    parser.add_argument(
        "--caption",
        default="M4A with sentence-aligned English and Simplified Chinese lyrics.",
        help="Telegram caption",
    )
    parser.add_argument(
        "--keep-output",
        action="store_true",
        help="Keep the M4A after successful Telegram send",
    )
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.is_file():
        print(f"error: input file not found: {input_path}", file=sys.stderr)
        return 2

    if (
        args.max_words < MIN_SPLIT_WORDS
        or args.max_chars < 1
        or args.max_seconds <= 0
        or args.pause_threshold <= 0
    ):
        print(
            "error: subtitle split thresholds must be positive and max-words must allow a complete phrase",
            file=sys.stderr,
        )
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
    sentences = words_to_sentences(
        words,
        max_words=args.max_words,
        max_chars=args.max_chars,
        max_seconds=args.max_seconds,
        pause_threshold=args.pause_threshold,
    )
    if not sentences:
        sentences = segments_to_sentences(
            result.get("segments") or [],
            max_words=args.max_words,
            max_chars=args.max_chars,
            max_seconds=args.max_seconds,
            pause_threshold=args.pause_threshold,
        )
    if not sentences:
        print("error: no word or segment timestamps returned by transcription API", file=sys.stderr)
        return 2

    translation_model = resolve_translation_model(args.translation_model)
    sentences = translate_sentences(sentences, api_key, translation_model)
    lrc_text = make_bilingual_lrc(sentences)
    export_m4a(input_path, output_path, lrc_text)

    sent = False
    if args.send_telegram:
        send_telegram_document(output_path, args.caption)
        sent = True

    print(json.dumps(
        {
            "ok": True,
            "sent_telegram": sent,
            "sentences": len(sentences),
            "bilingual": True,
            "m4a": str(output_path),
            "translation_model": translation_model,
        },
        ensure_ascii=False,
    ))

    if sent and not args.keep_output:
        try:
            output_path.unlink(missing_ok=True)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {redact(str(exc))}", file=sys.stderr)
        raise SystemExit(1)
