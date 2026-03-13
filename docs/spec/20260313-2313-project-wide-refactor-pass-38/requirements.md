# Project-wide Refactor Pass 38 - Chat Preference Persistence

## Goal

- 收敛前端 chat preference 的本地持久化规则，避免写入侧与恢复侧各自维护 `reasoningEffort` / `modelId` 的 normalize 与 storage key 逻辑。
- 保持现有 UI、WebSocket payload 和 localStorage 兼容行为不变。

## Requirements

- 新增共享 helper，统一：
  - `reasoningEffort` 的 normalize 语义；
  - `modelId` 的 normalize 语义；
  - localStorage key 的 session/chat 维度拼接规则。
- `client/src/app/tasks.ts` 的持久化写入必须复用共享 helper，不再保留本地重复实现。
- `client/src/app/projectsWs/webSocketActions.ts` 的恢复逻辑必须复用同一套 helper，避免 restore/save 规则漂移。
- 补充最小回归测试，至少覆盖：
  - `low -> medium` 与 invalid -> `high` 的推理强度归一；
  - 空/空白 model id 回退到 `auto`；
  - storage key 的 trim 与 fallback 语义。
- 更新 `docs/REFACTOR.md`，记录本轮 touched 模块、测试与 spec。
