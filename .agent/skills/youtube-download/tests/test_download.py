from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "download.py"
SPEC = importlib.util.spec_from_file_location("ads_youtube_download", SCRIPT_PATH)
assert SPEC and SPEC.loader
download = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(download)


class OutputDirTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = os.environ.get("ADS_YOUTUBE_DOWNLOAD_DIR")
        os.environ.pop("ADS_YOUTUBE_DOWNLOAD_DIR", None)
        self._saved_mkdir = Path.mkdir
        Path.mkdir = lambda *args, **kwargs: None  # type: ignore[method-assign]

    def tearDown(self) -> None:
        Path.mkdir = self._saved_mkdir  # type: ignore[method-assign]
        if self._saved_env is None:
            os.environ.pop("ADS_YOUTUBE_DOWNLOAD_DIR", None)
        else:
            os.environ["ADS_YOUTUBE_DOWNLOAD_DIR"] = self._saved_env

    def test_defaults_to_shared_download_dir(self) -> None:
        resolved = download.resolve_output_dir("")
        self.assertEqual(resolved, download.DEFAULT_DOWNLOAD_DIR.resolve())

    def test_never_writes_inside_the_repository_tree(self) -> None:
        resolved = download.resolve_output_dir("")
        self.assertNotIn(".ads", resolved.parts)
        self.assertFalse(str(resolved).startswith(str(download.ADS_ROOT)))

    def test_env_override_wins_over_default(self) -> None:
        os.environ["ADS_YOUTUBE_DOWNLOAD_DIR"] = "/tmp/ads-yt-env"
        self.assertEqual(download.resolve_output_dir(""), Path("/tmp/ads-yt-env"))

    def test_explicit_output_dir_wins_over_env(self) -> None:
        os.environ["ADS_YOUTUBE_DOWNLOAD_DIR"] = "/tmp/ads-yt-env"
        self.assertEqual(
            download.resolve_output_dir("/tmp/ads-yt-explicit"),
            Path("/tmp/ads-yt-explicit"),
        )

    def test_relative_output_dir_is_anchored_to_the_shared_dir(self) -> None:
        self.assertEqual(
            download.resolve_output_dir(".ads/youtube-downloads"),
            (download.DEFAULT_DOWNLOAD_DIR / ".ads/youtube-downloads").resolve(),
        )


class YoutubeDownloadTests(unittest.TestCase):
    def test_accepts_youtube_hosts(self) -> None:
        self.assertEqual(
            download.normalize_youtube_url("https://www.youtube.com/watch?v=abc"),
            "https://www.youtube.com/watch?v=abc",
        )
        self.assertEqual(
            download.normalize_youtube_url("https://youtu.be/abc"),
            "https://youtu.be/abc",
        )

    def test_rejects_non_youtube_hosts(self) -> None:
        with self.assertRaisesRegex(ValueError, "only youtube"):
            download.normalize_youtube_url("https://example.com/video")

    def test_builds_single_item_video_command(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            original_which = download.shutil.which
            download.shutil.which = lambda command: "/usr/bin/yt-dlp" if command == "yt-dlp" else None
            try:
                command = download.build_download_command(
                    url="https://youtu.be/abc",
                    output_dir=Path(temp_dir),
                    media_type="video",
                    audio_format="",
                    ffmpeg="/tmp/ffmpeg",
                )
            finally:
                download.shutil.which = original_which

        self.assertIn("--no-playlist", command)
        self.assertIn("--ffmpeg-location", command)
        self.assertIn(download.DEFAULT_VIDEO_FORMAT, command)
        self.assertEqual(command[-1], "https://youtu.be/abc")

    def test_audio_command_uses_requested_conversion(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            original_which = download.shutil.which
            download.shutil.which = lambda command: "/usr/bin/yt-dlp" if command == "yt-dlp" else None
            try:
                command = download.build_download_command(
                    url="https://youtu.be/abc",
                    output_dir=Path(temp_dir),
                    media_type="audio",
                    audio_format="mp3",
                    ffmpeg="/tmp/ffmpeg",
                )
            finally:
                download.shutil.which = original_which

        self.assertEqual(command[command.index("--audio-format") + 1], "mp3")

    def test_multipart_body_contains_caption_and_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            media_path = Path(temp_dir) / "sample.mp3"
            media_path.write_bytes(b"audio-bytes")
            body, boundary = download.encode_multipart(
                {"chat_id": "123", "caption": "done"},
                "audio",
                media_path,
            )

        self.assertIn(boundary.encode(), body)
        self.assertIn(b'name="caption"', body)
        self.assertIn(b"audio-bytes", body)


if __name__ == "__main__":
    unittest.main()
