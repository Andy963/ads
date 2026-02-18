# 20260213 - ADS brain/runner/ingest 讨论与方案

这里的内容分两部分：

1. **对话导出**：把我们围绕 `runner/ingest/brain` 的讨论按对话推进顺序整理出来，方便回看“为什么会得出这些结论”。
2. **方案文档（Spec 三件套）**：把最终收敛后的方案用 requirement/design/implementation 的形式写清楚，方便后续落地实现。

## 对话导出

- `docs/spec/20260213-ads-brain-runner/conversation-export.md`：简略版（只保留关键问答主线）。
- `docs/spec/20260213-ads-brain-runner/conversation-export-full.md`：完整重构版（比简略版更完整，但仍偏“摘要式”）。
- `docs/spec/20260213-ads-brain-runner/conversation-export-expanded.md`：扩展重构版（把 `brain/ingest` 的关键推理与细节写完整，接近逐轮对话的“人话表达”）。
- `docs/spec/20260213-ads-brain-runner/conversation-export-db-raw.jsonl`：数据库原文导出（从 `.ads/state.db` 的 `history_entries` 直接导出，不做省略/整理）。
- `docs/spec/20260213-ads-brain-runner/conversation-export-db-raw.txt`：数据库原文导出（同上，但更便于人类阅读与 grep）。

## Spec 三件套

- `docs/spec/20260213-ads-brain-runner/requirements.md`
- `docs/spec/20260213-ads-brain-runner/design.md`
- `docs/spec/20260213-ads-brain-runner/implementation.md`
