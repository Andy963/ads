# Design: Together Image Generation Skill

## 1. Metadata
| Field | Value |
| ----- | ----- |
| Version | 0.1.0 |
| Status | Draft |
| Authors | Codex |
| Created | 2026-02-12 |
| Last Updated | 2026-02-12 |
| Related Requirements | requirements.md |
| Related Implementation Plan | implementation.md |

## 2. Goals
- 在 ADS skill 体系中新增 `together-image`，提供稳定的“prompt -> image base64”能力。
- 尽量减少对主工程代码的侵入：实现落在 `.agent/skills/**` 下，便于热加载与维护隔离。
- 通过统一的 stdout 输出契约（仅 base64）让上层易于组合（Web/Telegram/CLI）。

## 3. Non-Goals
- 不增加前端 UI。
- 不引入数据库存储或缓存。
- 不要求引入 `together-ai` SDK 依赖（直接 REST 调用）。

## 4. Architecture

### 4.1 Skill layout
```
.agent/skills/together-image/
  SKILL.md
  scripts/
    together-image.cjs
```

### 4.2 Data flow
```
User request (generate image)
  -> Agent chooses skill
    -> run CLI script with prompt/model/options
      -> Together API /v1/images/generations
        -> response: b64_json (preferred) or url
      -> stdout: base64 only
      -> (optional) write file via --out
```

## 5. CLI Contract

### 5.1 Inputs
- `--prompt <text>` (required unless stdin provides content)
- `--model <id>` (default `Qwen/Qwen-Image`)
- Size:
  - `--size <WxH>` (e.g. `1024x1024`), or
  - `--width <n>` + `--height <n>`
- Optional generation controls:
  - `--steps <n>`
  - `--seed <n>`
  - `--n <n>` (default `1`)
- Output:
  - `--out <path>` (optional)
- Response handling:
  - `--response-format <b64_json|url>` (default `b64_json`)
- Timeout:
  - `--timeout-ms <n>` (overrides env)

### 5.2 Outputs
- Success: stdout prints only the base64 string (single line).
- Error: stdout prints nothing; stderr prints a concise error message.

## 6. Security Considerations
- 仅从环境变量读取 `TOGETHER_API_KEY`。
- 不在 stdout/stderr/日志中输出 key。
- 不默认落盘图片；仅在 `--out` 指定时写文件。

## 7. Failure Modes & Handling
- Missing key: fail fast with explicit message.
- Non-2xx upstream: extract best-effort error message from JSON and fail.
- `b64_json` missing but `url` present: download and convert to base64.
- Timeout: abort request and fail with timeout error.

