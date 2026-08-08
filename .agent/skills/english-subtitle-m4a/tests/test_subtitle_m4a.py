from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "subtitle_m4a.py"
SPEC = importlib.util.spec_from_file_location("subtitle_m4a", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT_PATH}")
subtitle_m4a = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(subtitle_m4a)


def word(text: str, start: float, end: float) -> dict[str, object]:
    return {"word": text, "start": start, "end": end}


class SubtitleM4ATest(unittest.TestCase):
    def test_pause_splits_missing_punctuation(self) -> None:
        sentences = subtitle_m4a.words_to_sentences(
            [
                word("Story", 0.0, 0.3),
                word("Three", 0.3, 0.6),
                word("Once", 1.5, 1.8),
                word("upon", 1.8, 2.1),
                word("a", 2.1, 2.2),
                word("time.", 2.2, 2.6),
            ]
        )

        self.assertEqual(
            [item["text"] for item in sentences],
            ["Story Three", "Once upon a time."],
        )
        self.assertEqual(sentences[1]["start"], 1.5)

    def test_long_sentence_prefers_clause_boundaries(self) -> None:
        tokens = (
            "The curious elephant, who asked questions all day, walked to the river "
            "because he wanted a clear answer."
        ).split()
        words = [
            word(token, index * 0.3, (index + 1) * 0.3)
            for index, token in enumerate(tokens)
        ]

        sentences = subtitle_m4a.words_to_sentences(
            words,
            max_words=8,
            max_chars=80,
            max_seconds=30.0,
            pause_threshold=0.75,
        )

        self.assertGreaterEqual(len(sentences), 2)
        self.assertEqual(" ".join(item["text"] for item in sentences), " ".join(tokens))
        self.assertTrue(all(len(item["text"].split()) <= 8 for item in sentences))
        self.assertTrue(any(item["text"].endswith(",") for item in sentences[:-1]))

    def test_translation_response_requires_every_id(self) -> None:
        content = """```json
{"translations":[{"id":2,"chinese":"\u7b2c\u4e00\u6761"},{"id":4,"chinese":"\u7b2c\u4e8c\u6761"}]}
```"""

        self.assertEqual(
            subtitle_m4a.parse_translation_response(content, [2, 4]),
            {2: "\u7b2c\u4e00\u6761", 4: "\u7b2c\u4e8c\u6761"},
        )

        with self.assertRaisesRegex(RuntimeError, "omitted sentence ids"):
            subtitle_m4a.parse_translation_response(content, [2, 3, 4])

    def test_translation_response_rejects_reordering_and_unexpected_scripts(self) -> None:
        reordered = (
            '{"translations":['
            '{"id":4,"chinese":"\\u7b2c\\u4e8c\\u6761"},'
            '{"id":2,"chinese":"\\u7b2c\\u4e00\\u6761"}]}'
        )
        unexpected_script = (
            '{"translations":['
            '{"id":2,"chinese":"\\u7b2c\\u4e00 \\u043a\\u0440\\u043e\\u043a\\u043e\\u0434\\u0438\\u043b"}]}'
        )

        with self.assertRaisesRegex(RuntimeError, "reordered, duplicated, or unexpected"):
            subtitle_m4a.parse_translation_response(reordered, [2, 4])
        with self.assertRaisesRegex(RuntimeError, "not valid Simplified Chinese"):
            subtitle_m4a.parse_translation_response(unexpected_script, [2])

    def test_bilingual_lrc_places_translation_below_english(self) -> None:
        chinese = "\u4f60\u597d\u3002"
        lrc = subtitle_m4a.make_bilingual_lrc(
            [{"start": 1.25, "end": 2.0, "text": "Hello.", "translation": chinese}]
        )

        self.assertEqual(lrc, f"[00:01.25] Hello.\n[00:01.25] {chinese}\n")

    def test_output_stem_normalizes_numeric_prefix(self) -> None:
        self.assertEqual(subtitle_m4a.output_stem(Path("03.mp3"), "-sub-zh"), "3-sub-zh")


if __name__ == "__main__":
    unittest.main()
