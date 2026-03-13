# Project-wide Refactor Pass 38 - Chat Preference Persistence

## Approach

- 新增 `client/src/lib/chatPreferences.ts`，只提供纯函数：
  - `normalizeReasoningEffort()`
  - `normalizeModelId()`
  - `buildReasoningEffortStorageKey()`
  - `buildModelIdStorageKey()`
- `client/src/app/tasks.ts` 继续负责“何时写入”，但不再关心规则细节；fallback 到 `activeProjectId` 的时机保持原样。
- `client/src/app/projectsWs/webSocketActions.ts` 继续负责“何时恢复”，但 key/normalize 全部复用共享 helper。

## Tradeoffs

- 本轮只收敛纯函数规则，不继续合并“persist/restore 生命周期”本身，避免扩大到 runtime 初始化与 WS connect 顺序。
- 不修改 `MainChat.vue` 内部的 model selector 展示逻辑，因为它处理的是 UI 选择器语义，不是 localStorage 契约。
