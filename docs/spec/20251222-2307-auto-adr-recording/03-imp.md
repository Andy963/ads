---
id: imp_a2uossvs
type: implementation
title: Auto ADR Recording - 实施
status: finalized
created_at: 2025-12-22T15:07:10.093Z
updated_at: 2025-12-22T17:13:35.000Z
---

# Auto ADR Recording - 实施

# Auto ADR Recording - 实施计划（A1）

> 目标：将 `<<<adr {JSON} >>>` 控制块（可多条）解析为 ADR 文件写入 `docs/adr/`，并维护 `docs/adr/README.md` 索引；对用户输出不展示控制块，仅追加“已记录 ADR”的路径摘要。

## 0. 关联文档
- Requirements（已定稿 v2）：`docs/spec/20251222-2307-auto-adr-recording/01-req.md`
- Design（已定稿 v1）：`docs/spec/20251222-2307-auto-adr-recording/02-des.md`

## 1. 实现范围与入口（代码落点）
本能力需要覆盖多个入口（需求 Scope）：CLI / Web / Telegram。现有输出管线中共性点是：
- `stripLeadingTranslation(...)`：用于清理输出前缀
- 部分入口会 `parseStructuredOutput(...)` 抽取 `answer/plan`

建议做法：实现一个**共享的 ADR 后处理模块**，并在三个入口的“最终输出落地之前”调用。

已定位的关键入口（后续编码时确认具体抽象）：
- 命令行入口：已移除
- Web：`src/web/server.ts`（在 websocket `result` 发送与 `sessionLogger.logOutput` 之前）
- Telegram：`src/telegram/adapters/codex.ts`（在 `stripLeadingTranslation/parseStructuredOutput` 后、发送消息前）

## 2. 交付物（Definition of Done）
- [ ] `docs/adr/` 自动创建（若不存在）
- [ ] 支持在单次回复中解析多个 ADR 控制块
- [ ] 合法 ADR：
  - [ ] 生成 `docs/adr/000x-<slug>.md`（不覆盖，编号递增直到空闲）
  - [ ] 渲染头部（`# ADR-0007: <title>` + Status/Date）+ 正文
  - [ ] 更新/生成 `docs/adr/README.md` 索引（标记区块内自动生成，升序）
- [ ] 非法 JSON：
  - [ ] 忽略该块，不中断主回答
  - [ ] 在输出末尾追加 1 行可读警告
- [ ] 用户输出：
  - [ ] 不包含 `<<<adr ... >>>` 控制块原文
  - [ ] 成功时追加 “ADR recorded: …” 的路径列表
- [ ] 默认开启，不提供开关

## 3. 任务拆解

- [ ] IMP-1. 新增 ADR 后处理模块（解析 + 输出清理）
  - Owner: Codex
  - Steps:
    - 新增 `src/utils/adrRecording.ts`（或同等目录）提供 `processAdrBlocks(text, workspaceRoot): { cleanedText, results, warnings }`
    - 解析规则：匹配 `<<<adr` 到 `>>>` 的块（支持多条、容忍空白/换行）
    - 将控制块从输出中移除（仅移除该块，不影响其他文本）
  - Verification Checklist:
    - 多块场景能全部提取、且输出清理后正文不被破坏
    - 非法 JSON 块被忽略但能生成 warning
  - Requirements: FR-1, FR-5, NFR-2

- [ ] IMP-2. 标题缺省自动生成（不要求用户输入）
  - Owner: Codex
  - Steps:
    - 若 `title` 缺省：按需求的优先级补齐（`body` 第一标题/首行 → `decision` → `Untitled ADR`）
    - 确保标题生成稳定且可读（截断到 60 字符）
  - Verification Checklist:
    - `title` 缺省时仍可生成可读文件名与 ADR 标题
  - Requirements: FR-1（title 缺省补齐）

- [ ] IMP-3. 编号选择 + slug 生成 + Markdown 渲染
  - Owner: Codex
  - Steps:
    - 扫描 `docs/adr/` 的现有 `^\\d{4}-` 文件，取 max 编号并递增
    - 若目标文件已存在，继续递增直到空闲（不覆盖）
    - slug：由标题（含默认标题）小写化、空白转 `-`、去除非法字符、截断
    - 渲染：统一头部 + `body` 原样或标准章节渲染
  - Verification Checklist:
    - 不覆盖已有 ADR 文件
    - 生成的 Markdown 结构符合设计
  - Requirements: FR-2, FR-3, NFR-1

- [ ] IMP-4. README 索引生成（标记区块）
  - Owner: Codex
  - Steps:
    - 确保 `docs/adr/README.md` 存在；若不存在则创建最小骨架 + 标记区块
    - 在 `<!-- ADS:ADR_INDEX_START -->` 与 `<!-- ADS:ADR_INDEX_END -->` 之间生成索引
    - 索引按编号升序，至少包含编号、标题、相对路径链接
  - Verification Checklist:
    - 反复运行不会重复追加内容（幂等）
    - 保留标记区块外的人工编辑内容
  - Requirements: FR-4

- [ ] IMP-5. 接入 CLI 输出管线
  - Owner: Codex
  - Steps:
    - （Removed）不再支持命令行入口；无需接入 ADR 后处理
  - Verification Checklist:
    - （不适用）
  - Requirements: Scope（CLI）

- [ ] IMP-6. 接入 Web 输出管线
  - Owner: Codex
  - Steps:
    - 在 `src/web/server.ts` 中，在 websocket `result` 发送之前调用 ADR 后处理
    - 确保 `sessionLogger.logOutput` 记录的是“清理后的最终输出”
  - Verification Checklist:
    - Web 端触发 ADR 后，前端收到的 output 不含控制块，且包含路径提示
  - Requirements: Scope（Web）

- [ ] IMP-7. 接入 Telegram 输出管线
  - Owner: Codex
  - Steps:
    - 在 `src/telegram/adapters/codex.ts` 中，在对外发送文本前调用 ADR 后处理
    - 注意 Telegram markdown 转换与消息长度限制：路径提示保持简短
  - Verification Checklist:
    - Telegram 端触发 ADR 后，消息不含控制块且能提示落盘路径
  - Requirements: Scope（Telegram）

- [ ] IMP-8. 无需功能开关（默认启用）
  - Owner: Codex
  - Notes:
    - ADR 记录默认启用，不提供 `ADS_ADR_ENABLED` 配置项
  - Requirements: NFR-3

- [ ] IMP-9. 单元测试
  - Owner: Codex
  - Command / Script: `npm test`
  - Steps:
    - 新增测试覆盖：多块解析、非法 JSON 容错、编号递增不覆盖、README 幂等
    - 采用临时目录作为 workspaceRoot（仅在测试里写入 `docs/adr`）
  - Verification Checklist:
    - `npm test` 全绿
  - Requirements: NFR-2, 验收与验证

- [ ] IMP-10. 手动验证清单
  - Owner: Codex
  - Steps:
    - CLI：启动并让 agent 输出包含 `<<<adr ... >>>` 的回复，检查 `docs/adr/` 与 README
    - Web：同上（看前端输出与落盘）
    - Telegram：同上（看 bot 输出与落盘）
  - Verification Checklist:
    - 三入口都能落盘 + 输出不含控制块 + 有路径提示

## 4. 风险与对策
- 风险：agent 忘记输出 `<<<adr ... >>>` → 本次不记录
  - 对策：已在设计中明确“提示词硬约束 + 用户补录机制”（实现阶段补齐提示词/规则位置）
- 风险：并发写入导致编号冲突
  - 对策：写入前检查存在性，若存在则自增重试；必要时可加简易文件锁（先不强制）
- 风险：路径穿越 / 写到 workspace 外
  - 对策：写入路径固定为 `${workspaceRoot}/docs/adr`，并校验 resolvedPath 前缀
- 风险：README 被重复追加
  - 对策：使用固定标记区块，生成逻辑幂等

## 5. 验证命令
- 单测：`npm test`
-（可选）覆盖率：`npm run coverage`
-（若改动到 Web 前端相关代码才需要）`npm run build`

## 6. 变更记录
- 2025-12-22：创建实施计划草稿（待确认后定稿）
