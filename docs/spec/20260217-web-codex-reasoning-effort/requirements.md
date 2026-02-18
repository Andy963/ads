# Web: Codex reasoning effort selector

## 背景

Web 端当前支持选择 agent / model，但无法在对话维度为 Codex 配置 `model_reasoning_effort`。Codex CLI 支持通过 `--config` 覆盖配置项，因此需要在 Web UI 增加选择并确保参数在 spawn CLI 时生效。

## 目标

1. Web UI 支持为 **Codex** 选择 reasoning effort 等级，并在每次发送 prompt 时生效。
2. 该参数必须传递到 spawn 的 `codex exec ...` 调用中（通过 `--config model_reasoning_effort=...`）。
3. 支持的预置值至少包含：`default`（不覆盖）、`low`、`medium`、`high`、`xhigh`。

## 非目标

- 不扩展 task queue / 任务模型的持久化字段（本次只覆盖 Web chat prompt）。
- 不保证其它 agent（Amp/Claude/Gemini/Droid）理解该参数（允许忽略）。

## 需求

### 功能

- 用户可以在 Web chat（Worker / Planner）中选择 reasoning effort。
- 选择应当影响后续 prompt，不要求影响历史消息。
- 选择为 `default` 时，不向 Codex CLI 传递该覆盖项（使用 Codex 自身的默认/配置文件值）。

### 安全性

- 服务端必须对来自 Web payload 的 effort 值进行基本校验，避免将包含控制字符/异常长度的值透传到 CLI 参数。

### 可用性

- 允许在页面刷新后保留最近一次选择（本地持久化即可）。

## 验收标准

- Web UI 可以切换到 `xhigh`，发送 prompt 后 backend spawn 的 Codex CLI 参数包含对应的 `--config model_reasoning_effort=...`。
- 选择为 `default` 时不附带该 `--config` 覆盖项。
- `npx tsc --noEmit`、`npm run lint`、`npm test` 通过；由于涉及前端改动，额外 `npm run build` 通过。

