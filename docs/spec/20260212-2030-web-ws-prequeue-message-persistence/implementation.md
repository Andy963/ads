# Implementation: Web WS pre-queue persistence

> 日期：2026-02-12  
> 状态：Draft

## Changes

1. `src/web/server/ws/server.ts`
   - 在 `ws.on("message")` 入口处完成：
     - JSON + schema validate
     - 对 `prompt/command` 做 early persist + ack + dedupe
     - dedupe 命中则不入 `messageChain`
   - `messageChain` 中的 handler 改为接收已解析消息与 `receivedAt`（用于 injection cutoff）

2. `src/web/server/ws/handlePrompt.ts`
   - 当存在 `client_message_id` 时，不再重复写入 `history_entries`/发送 ack
   - history injection 读取 history 时增加 `ts <= receivedAt` 过滤

3. `src/web/server/ws/handleCommand.ts`
   - 当存在 `client_message_id` 时，不再重复写入 `history_entries`/发送 ack（由 server.ts 统一处理）

4. Tests
   - 新增回归测试：当一条 `command` 阻塞时，后续带 `client_message_id` 的 `command` 在断线前即可落库，断线后仍可从 `history_entries` 读到。

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```

