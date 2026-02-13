# Requirements: Together Image Generation Skill

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 初稿 |
| Status | Draft | 待评审 |
| Owner | Codex | 执行人 |
| Created | 2026-02-12 | |
| Updated | 2026-02-12 | |
| Related Design | design.md | |
| Related Plan | implementation.md | |

## Introduction
- 背景：当前 ADS 的 skill 体系已用于搜索（Tavily）与其他工作流，但缺少“生成图片”的统一入口。
- 目标：新增一个 `together-image` skill，通过 Together API 生成图片，并以 `base64`（默认）形式返回，便于在 Web/Telegram/CLI 等多入口复用。

## Scope
- In Scope
  - 新增 `.agent/skills/together-image/`，提供 `SKILL.md` 与可执行脚本。
  - 使用 Together REST API `https://api.together.xyz/v1/images/generations` 生成图片。
  - 默认模型：`Qwen/Qwen-Image`（可通过参数覆盖）。
  - 读取 `TOGETHER_API_KEY` 环境变量作为凭证。
  - 输出 `base64`（优先）到 stdout，并可选将图片写入本地文件。
- Out of Scope
  - Web 前端新增 UI 或路由改动。
  - 将生成结果写入数据库或做缓存/持久化（除非用户显式指定 `--out`）。
  - 内置 Together SDK 依赖（优先保持零新增依赖，使用 `fetch` 调用 REST API）。

## Functional Requirements

### Requirement R1: 基础生成能力（Prompt -> Image Base64）
**User Story:** 作为调用方（Codex/Claude/ADS agent），我希望只提供 prompt 就能生成图片，并拿到可直接渲染/保存的 base64 数据。

#### Acceptance Criteria
- [ ] 提供命令行入口：`node .agent/skills/together-image/scripts/together-image.cjs --prompt "..."`。
- [ ] 默认 `model="Qwen/Qwen-Image"`，允许通过 `--model` 覆盖。
- [ ] 成功时 stdout 仅输出图片 base64（不包含额外文本），便于上层直接复用。
- [ ] 支持常用可选参数：`--size 1024x1024`（或 `--width`/`--height`）、`--steps`、`--seed`、`--n`。

#### Validation Notes
- 手动验证：给定简单 prompt 能返回非空 base64 字符串。

### Requirement R2: 凭证读取与安全输出
**User Story:** 作为维护者，我希望凭证仅通过环境变量注入，且不会被写入日志或输出。

#### Acceptance Criteria
- [ ] 从环境变量读取 `TOGETHER_API_KEY`；缺失时明确报错。
- [ ] 脚本不得打印或回显 API key（stdout/stderr 均禁止）。

#### Validation Notes
- 手动验证：缺失 key 时返回可读错误；检查输出中不包含 key 字符串。

### Requirement R3: URL 回退（上游未返回 b64_json）
**User Story:** 作为调用方，我希望即使上游只返回图片 URL，脚本也能回退为 base64 输出，保持接口一致。

#### Acceptance Criteria
- [ ] 若响应中无 `b64_json` 但存在 `url`，脚本应下载该 URL 并转换为 base64 输出。

#### Validation Notes
- 手动验证：通过 `--response-format url` 强制 URL 模式仍能返回 base64（如果上游支持）。

### Requirement R4: 可选落盘输出
**User Story:** 作为调用方，我希望在需要时将生成的图片写入本地文件，便于后续检查或共享。

#### Acceptance Criteria
- [ ] 支持 `--out <path>` 将 base64 解码后写入文件。
- [ ] 写文件失败时返回明确错误（不影响 stdout 输出契约：失败则不输出 base64）。

#### Validation Notes
- 手动验证：输出文件存在且可被常见图片查看器打开。

## Non-Functional Requirements
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| 兼容性 | Node.js 版本 | `>= 20` | 与项目 engines 一致 |
| 可靠性 | 超时控制 | 默认 120s，可配置 | 人工/日志 |
| 可维护性 | 零新增依赖 | 仅使用内置 `fetch` | 代码审查 |
| 安全 | 不泄露凭证 | 不打印/不落盘 key | 代码审查 |

## Configuration
- `TOGETHER_API_KEY`：必填。
- `ADS_TOGETHER_IMAGE_TIMEOUT_MS`：可选，默认 `120000`，最小 `1000`。

## Change Log
| Version | Date | Description | Author |
| ------- | ---- | ----------- | ------ |
| 0.1.0 | 2026-02-12 | 初稿 | Codex |

