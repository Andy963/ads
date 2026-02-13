---
id: req_x121o1be
type: requirement
title: Auto ADR Recording - 需求
status: finalized
created_at: 2025-12-22T15:07:10.090Z
updated_at: 2025-12-22T15:54:16.000Z
---

# Auto ADR Recording - 需求

> 更新（2026-02-12）：ADS 不再支持用户侧 CLI 入口；本文档中关于 CLI 的内容仅作为历史背景描述，当前支持入口为 Web Console + Telegram Bot。

# 自动 ADR 记录 - Requirements（A1：显式块触发 + 一决策一文件）

## Metadata
- Status: Draft
- Owner: ADS (Codex)
- Created: 2025-12-22
- Scope: ADS 核心代码（CLI/Web/Telegram 通过 agent hub 的对话输出）

## 背景与目标

目前 ADR 需要人工创建/维护，容易出现：
- 架构决策存在于聊天记录/设计文档中，但没有被结构化沉淀；
- 同一决策重复讨论，缺少“已决定”的单点事实来源；
- 新人难以快速定位“为什么这么做”。

目标：当主管 agent 在回复中**显式声明**“这是一个 ADR”，系统自动将其落盘到 `docs/adr/`，并维护索引，形成可追溯的决策库。

## 范围（Scope）

### In Scope
- 触发方式：仅当 agent 回复包含 `<<<adr ... >>>` 块时触发（A 方案，避免噪音）。
- 落盘方式：一决策一文件（1 方案），生成 `docs/adr/000x-<slug>.md`。
- 自动维护 `docs/adr/README.md` 索引（按编号排序）。
- 在最终对用户输出中显示“已记录 ADR”的摘要（包含文件路径）。

### Out of Scope（本期不做）
- 自动从任意对话内容“猜测”决策并生成 ADR（B 方案）。
- 在 `/ads.commit design` 时自动从设计稿抽取 ADR（C 方案，后续可扩展）。
- 与 ADS 图数据库（`ads.db`）绑定/存储 ADR 元数据（本期只写文件）。
- 支持“更新已有 ADR”或“Superseded 链接自动维护”（后续增强）。

## ADR 块格式（对 agent 的约束）

系统识别的 ADR 块格式：

```
<<<adr
{JSON}
>>>
```

其中 JSON 需至少包含：
- `title`：string（决策标题，可选；若缺省则由系统生成）

建议字段（可选）：
- `status`：`Proposed | Accepted | Rejected | Deprecated | Superseded`
- `date`：`YYYY-MM-DD`（不填则用生成当日）
- `context` / `decision` / `consequences` / `alternatives` / `references`
- 或直接给 `body`（markdown），系统仅负责补齐 ADR-编号与元信息头部。

### 标题缺省时的默认生成规则
- WHEN `title` 缺省 THEN 系统应生成一个稳定且可读的默认标题（不要求用户输入）。
- 默认标题生成优先级：
  1. 若提供 `body`：提取 `body` 中的第一个 Markdown 标题（`# ...`），若不存在则取第一行非空文本（截断到 60 字符）。
  2. 否则若提供 `decision`：取 `decision` 的第一句/前 60 字符。
  3. 否则：使用 `Untitled ADR`。

## 功能性需求（Functional Requirements）

### FR-1：识别 ADR 块并抽取内容
- [ ] WHEN agent 回复包含一个或多个 `<<<adr ... >>>` THEN 系统应解析出对应 ADR 记录（允许多条）。
- [ ] WHEN `<<<adr ... >>>` 块内容不是合法 JSON THEN 系统应忽略该块并在输出中给出可读警告（不中断对话）。
- [ ] WHEN `title` 缺省 THEN 系统应按“标题缺省时的默认生成规则”补齐标题。

### FR-2：生成文件名与编号（顺序、不覆盖）
- [ ] WHEN 写入 ADR THEN 系统应在 `docs/adr/` 下选择下一个可用编号（4 位补零，示例 `0007`）。
- [ ] WHEN 目标文件已存在（极少数并发/重复场景）THEN 自动递增编号直到找到空闲编号，且不得覆盖已有文件。
- [ ] WHEN `docs/adr/` 不存在 THEN 自动创建目录（仅在 workspace 内）。

### FR-3：渲染 ADR Markdown（标准结构）
- [ ] WHEN ADR 记录缺少 `body` THEN 使用标准章节（Context/Decision/Consequences/Alternatives/References）按字段渲染。
- [ ] WHEN ADR 记录包含 `body` THEN 生成文件应以统一 Header（ADR-编号、Status、Date）开头，后续追加 `body` 原文。

### FR-4：更新索引
- [ ] WHEN 成功写入 ADR 文件 THEN 系统应更新/生成 `docs/adr/README.md`，列出所有 ADR（按编号升序）。

### FR-5：用户可见反馈（但不污染主要回答）
- [ ] WHEN 成功写入 ADR THEN 最终回复应追加一段简短提示：写入了哪些 ADR 文件路径。
- [ ] WHEN 写入失败 THEN 最终回复应提示失败原因，但不影响主要回答内容输出。

## 非功能性需求（Non-Functional Requirements）

- NFR-1：安全与边界
  - 只允许写入 workspace 内 `docs/adr/`，不得写到其他路径。
  - 不得删除/覆盖任何 `.db/.sqlite/.sqlite3` 文件。
- NFR-2：可测试性
  - ADR 解析、编号选择、索引生成需可在单元测试中验证。
- NFR-3：可配置性（最低限度）
  - 默认开启，不提供开关。

## 验收与验证

- 通过单元测试验证：
  - 多 ADR 块解析
  - 非法 JSON 的容错
  - 编号递增、不覆盖
  - README 索引生成排序与标题提取
- 手动验证：在 CLI/Web/Telegram 任一入口，让 agent 输出 ADR 块，观察：文件落盘 + 回复追加提示。

## 变更记录
- 2025-12-22：创建需求（A1：显式块触发 + 一决策一文件）
