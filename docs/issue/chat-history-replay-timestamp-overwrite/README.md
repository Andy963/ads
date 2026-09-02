# Issue: 重新打开 PWA/Web 时历史消息时间戳被覆盖为当前时间 (Timestamp Overwrite on Replay)

## 1. 现象描述 (Symptom)

在重新打开 ADS PWA 或刷新 Web 端时：
- Worker 聊天面板中的所有历史消息（包括数小时前或数天前的对话）；
- 其气泡下方标记的时间全部变成了**当前重新打开应用的一瞬间的时间**；
- 导致历史对话的时序可读性被破坏，无法辨识每条消息真实发生的历史时间。

## 2. 根因分析 (Root Cause)

该问题由前端两处逻辑共同导致：

### 2.1 `pushMessageBeforeLive` 盲目使用 `Date.now()` 兜底
在 `client/src/app/chat.ts:336` 中：
```ts
const pushMessageBeforeLive = (item: Omit<ChatItem, "id"> & { id?: string }, rt?: ProjectRuntime): void => {
  const state = runtimeOrActive(rt);
  const existing = state.messages.value.slice();
  const liveIndex = findFirstLiveIndex(existing);
  const explicitId = String(item.id ?? "").trim();
  const next = { ...item, id: explicitId || randomId("msg"), ts: item.ts ?? Date.now() }; // 💥 错误兜底
  // ...
};
```

### 2.2 历史回放时部分条目 `ts` 解析为 undefined
在 `client/src/app/projectsWs/wsMessage.ts:1123` 中，当从服务端重放历史 `history` 事件时：
- 如果条目没有合法数值型 `ts`，变量 `ts` 会被解析为 `null` / `undefined`；
- 当这些消息被构造成 `ChatItem` 传入 `pushMessageBeforeLive` 时，触发了 `ts: item.ts ?? Date.now()`；
- 导致打开应用的那一刻，所有历史条目都被打上了当下的浏览器时间戳。

## 3. 期望行为与决策 (Decisions & Expected Behavior)

1. **禁止在历史消息回放中注入 `Date.now()`**：
   - 区分“实时新发消息”与“历史重放消息”；
   - 历史消息如果没有有效时间戳，保持 `ts: undefined`，严禁使用当前时刻覆盖。
2. **保证前后端时间戳透传完整**：
   - 后端 `HistoryStore`（Sqlite `history_entries.ts`）和 `bootstrapReplay.ts` 确保向前端序列化有效的整数毫秒时间戳；
   - 前端格式化组件只在 `ts` 合法且大于 0 时渲染时间标签。

## 4. 约束与验收标准 (Acceptance Criteria)

- 刷新页面或重新打开 PWA 时，所有历史消息必须显示其真实的原始历史时间。
- 缺少时间戳的旧数据卡片不显示错误时间，保持空或优雅降级。
- 包含单元测试：模拟 `history` 事件下发无 `ts` 或带原始 `ts` 的记录，验证界面渲染的时间戳未被篡改为当前时间。
