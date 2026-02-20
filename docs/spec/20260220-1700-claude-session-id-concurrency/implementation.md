# Implementation

## 改动概览

- `src/agents/adapters/claudeCliAdapter.ts`
  - 引入 `AsyncLock`，将 `send()` 串行化，避免并发复用 `--session-id`。
  - 在 `send()` in-flight 时对 `reset()` / `setWorkingDirectory()` 的 session reset 做延迟处理（`pendingReset`），保证 turn 内 threadId 稳定。
- `tests/agents/claudeCliAdapter.test.ts`
  - 新增回归测试：并发两次 `send()` 不应触发 `Session ID ... is already in use`。
  - 新增回归测试：in-flight `send()` 期间调用 `setWorkingDirectory()` 不应立即改变 `getThreadId()`。

## 验证

```bash
npx tsc --noEmit
npm run lint
npm test
```

## 预期行为

- 并发触发 `ClaudeCliAdapter.send()` 时，后续调用会在 adapter 内排队执行。
- `setWorkingDirectory()` 在 turn 进行中被调用时，会更新 `workingDirectory`，但 sessionId 的 reset 会延迟到下一次 `send()` 开始前生效。

