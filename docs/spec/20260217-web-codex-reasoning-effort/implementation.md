# Implementation plan

## 后端

1. `src/agents/types.ts`
   - Add optional `setModelReasoningEffort` to `AgentAdapter`.
2. `src/agents/orchestrator.ts`
   - Add `setModelReasoningEffort(effort?: string)` and broadcast to adapters.
3. `src/agents/adapters/codexCliAdapter.ts`
   - Store `modelReasoningEffort?: string`.
   - Include `--config model_reasoning_effort="..."` in `buildArgs()` when set.
4. `src/web/server/ws/handlePrompt.ts`
   - Parse `model_reasoning_effort` from WS payload object.
   - Validate against allow-list (`low|medium|high|xhigh`) and call `orchestrator.setModelReasoningEffort(...)` before `runCollaborativeTurn`.

## 前端

1. `web/src/app/controllerTypes.ts` + `web/src/app/projectRuntime.ts`
   - Add `modelReasoningEffort` field to runtime state (default `default`).
2. `web/src/app/chat.ts`
   - When sending WS `prompt`, include `model_reasoning_effort` from runtime when not `default`.
3. `web/src/app/tasks.ts`
   - Add setters to update Worker / Planner runtime effort from UI.
4. `web/src/components/MainChat.vue` + `web/src/App.vue`
   - Add a selector in chat toolbar.
   - Wire state + events for both panes.
   - Persist selection via `localStorage` (keyed by `sessionId + chatSessionId`).

## 测试

- Backend unit test: ensure `CodexCliAdapter` includes/excludes the `--config model_reasoning_effort=...` arg.
- Frontend test (jsdom): ensure switching effort changes the payload sent through `AdsWebSocket.sendPrompt`.

## 验证命令

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```

