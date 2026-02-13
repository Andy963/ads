---
id: imp_su4fiika
type: implementation
title: Tavily Search Tool - 实施
status: finalized
created_at: 2025-12-05T08:15:02.812Z
updated_at: 2025-12-05T00:31:26.000Z
---

# Tavily Search Tool - 实施

> 更新（2026-02-11）：ADS 已移除内置 Tavily runtime 集成（`src/tools/search/**`）。联网搜索与 URL 抓取改为通过 skill 脚本 `.agent/skills/tavily-research/scripts/tavily-cli.cjs` 提供；本 spec 中关于内置实现的内容仅作为历史记录保留。

# Implementation Plan: Tavily Search Tool

## 准备事项
- [x] 对照需求/设计，确认范围：配置/Key 失败切换/限流/日志/错误分类/JSON 输出。
- [x] 受影响文件：`tools/index.ts`、`tools/search/{types,config,keyManager,rateLimiter,client,service,index}.ts`（新增），`logs/tavily-search.log`（生成）。
- [x] 验证方式：单测（mock Tavily）、日志检查、如有必要运行 `npm test`。

## 阶段任务

- [ ] T1. 定义类型与配置默认值
  - Owner: Codex
  - ETA: 今日
  - Branch / PR: N/A
  - Status Notes: TODO
  - Steps:
    - 新增 `tools/search/types.ts` 定义 SearchParams/Result/Response、错误类型。
    - 新增 `tools/search/config.ts` 解析 env（`TAVILY_API_KEYS` 逗号分隔，兜底 `TAVILY_API_KEY`），默认值：maxResults=5 上限10、timeout=30s、retries=3、concurrency=3、rps=3、logPath=logs/tavily-search.log。
  - Command / Script: N/A
  - Verification Checklist:
    - 类型覆盖需求字段且无冗余。
    - 默认值与上限符合需求。

- [ ] T2. Key 管理与限流组件
  - Owner: Codex
  - ETA: 今日
  - Branch / PR: N/A
  - Status Notes: TODO
  - Steps:
    - 新增 `keyManager.ts`：顺序失败切换，记录当前索引，支持单 Key。
    - 新增 `rateLimiter.ts`：并发 3、TPS 3 默认，可配置，超限排队。
  - Command / Script: N/A
  - Verification Checklist:
    - 无 Key 时抛配置错误。
    - 可并发/速率限制生效（通过单测或逻辑验证）。

- [ ] T3. Tavily 客户端封装（超时/重试/错误分类）
  - Owner: Codex
  - ETA: 今日
  - Branch / PR: N/A
  - Status Notes: TODO
  - Steps:
    - 新增 `client.ts`：包装 `@tavily/core`，应用超时、重试≤3，对可重试错误切换下一 Key。
    - 错误分类：config/input/timeout/quota/auth/network/internal/no_key。
  - Command / Script: N/A
  - Verification Checklist:
    - 可重试错误会重试并换 Key；不可重试直接返回。
    - 超时与错误类型分类正确。

- [ ] T4. Search Service 与导出
  - Owner: Codex
  - ETA: 今日
  - Branch / PR: N/A
  - Status Notes: TODO
  - Steps:
    - 新增 `service.ts`：参数校验/裁剪 maxResults，上下游调用 RateLimiter + KeyManager + Client，归一化响应 meta(results/total/tookMs)。
    - 新增 `logging`（可在 service 或独立模块）：JSON 行写入 `logs/tavily-search.log`，字段含 timestamp、query 摘要、keyIndex、durationMs、resultCount、errorType（不含 Key，query 可截断）。
    - `tools/search/index.ts` 与 `tools/index.ts` 导出入口。
  - Command / Script: N/A
  - Verification Checklist:
    - 输出符合契约且裁剪上限 10。
    - 日志落盘且不含敏感信息。

- [ ] T5. 测试与验证
  - Owner: Codex
  - ETA: 今日
  - Branch / PR: N/A
  - Status Notes: TODO
  - Steps:
    - 添加单测（mock Tavily）：无 Key 错误；单 Key 成功；多 Key 前失败后成功；maxResults 裁剪；不可重试错误不重试；可重试错误切 Key 重试；日志写入检查（可截断）。
    - 运行 `npm test`（或目标测试命令）。
  - Command / Script: `npm test`
  - Verification Checklist:
    - 测试通过且覆盖主要路径。
    - 日志文件生成且字段齐全、无 Key。

- [ ] T6. 收尾与风险
  - Owner: Codex
  - ETA: 今日
  - Branch / PR: N/A
  - Status Notes: TODO
  - Steps:
    - 自检代码/类型/格式；必要时运行 lint（如时间允许）。
    - 总结验证结果，准备 `/ads.review` 所需信息。
  - Command / Script: `npm test`（已在 T5），`npm run lint`（如执行）
  - Verification Checklist:
    - 自检通过，无未处理 TODO。
    - 风险/限制在回复中说明。

## 状态追踪
- 记录方式：更新此实施计划与对话记录。
- 更新频率：阶段完成后即时更新。
- 风险与阻塞：暂无（如遇网络受限需标注并调整验证方式）。

## 变更记录
- 2025-12-05：初稿（Codex）
