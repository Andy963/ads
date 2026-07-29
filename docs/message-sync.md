# ADS Web 消息同步方案

状态：设计草案
适用范围：`client/src/app/*`、`server/web/server/ws/*`、`server/utils/historyStore.ts`、`server/web/server/start/webSocketHub.ts`

---

## 1. 结论先行

断线后消息不同步，**不是 WebSocket 协议选型的问题**，而是缺少「可恢复的同步机制」。

- `WebSocket` 本身就跑在 `TCP` 上，已经有可靠有序传输；浏览器端也拿不到原生 `TCP/UDP` socket。
- 换成 `UDP/TCP` 自研协议，对网页端不可行，且不能解决"连接断开的那段时间里发生的事件丢了"这个根因。
- 聊天软件之所以看起来"稳"，靠的是 **服务端事件日志 + 单调递增 seq + 客户端 cursor + 重连补拉**，长连接只是加速通道。

所以目标形态是：

```text
持久事件日志   ← 唯一真相来源（durable，可回放）
     │
     ├── WebSocket   ← 低延迟通知（可丢，可重复）
     └── HTTP catch-up ← 断线/切后台/首屏的补齐通道（可靠）
```

"WebSocket 仅用于紧急中断后台动作"这个方向是对的，但更准确的表述是：**WebSocket 不再是消息的唯一投递路径**，包括中断动作本身也应该有 HTTP 兜底。

---

## 2. 现状盘点（基于当前代码）

### 2.1 连接身份

- 客户端用子协议携带身份：`ads-v1`、`ads-session.<sessionId>`、`ads-chat.<chatSessionId>`（`client/src/api/ws.ts`）。
- 服务端在 `server/web/server/ws/session.ts` 解析，`connectionIdentity.ts` 派生出：

  ```ts
  const historyKey = `${authUserId}::${sessionId}::${chatSessionId}`;
  ```

- `sessionId` = 项目 id，持久化在 `localStorage["ADS_WEB_PROJECTS"]`；`chatSessionId` 为 `main` / `planner`。
  **身份跨重连和刷新是稳定的**，这是一个很好的既有基础。

### 2.2 已有的持久化

`server/state/schemaMigrations.ts`：

```sql
CREATE TABLE IF NOT EXISTS history_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  session_id TEXT NOT NULL,     -- 即 historyKey
  role TEXT NOT NULL,           -- user | ai | status
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT
);
```

以及一个基于 `kind LIKE 'client_message_id:%'` 的部分唯一索引，用于入站幂等。

落库的内容：用户 prompt、最终 assistant 文本、error/status、plan 快照、部分任务里程碑。

### 2.3 已有的扇出

- 聊天：`broadcastJsonToHistoryKey`（`connectionRuntime.ts`）按 `historyKey` 广播给**同一账号同一项目同一 lane 的所有连接** —— 多端实时同步的基础已经具备。
- 任务：`webSocketHub.broadcastToSession` 按 `sessionId` 或 workspace 匹配广播 `task:event`。

### 2.4 已有的重连与幂等

- 客户端指数退避重连：`800ms → 15s` 上限，无重试次数上限（`client/src/app/projectsWs/webSocketActions.ts` 的 `scheduleReconnect`）。
- `onOpen` 时若 `needsTaskResync` 为真，走 HTTP 重拉任务态：`GET /api/task-queue/status` + `GET /api/tasks`。
- 入站 prompt 幂等：`client_message_id` + `INSERT OR IGNORE` + `ack{duplicate}`（`ws/preflight.ts`、`historyStore.ts`）。
- 重连补齐 prompt 状态：`welcome.completedClientMessageIds` 与 `replay_incomplete` 重放。
- 出站有 outbox：`rt.queuedPrompts` + `sessionStorage["ads.pendingPrompt.<sessionId>.<chatSessionId>"]`。

**结论：地基不差。缺的是"可寻址的事件流"和"聊天侧的 HTTP 补拉通道"。**

---

## 3. 缺口分析：为什么断开后就不同步了

| 编号 | 缺口 | 位置 | 后果 |
| --- | --- | --- | --- |
| G1 | 没有对客户端可见的单调 seq，客户端也没有 cursor | `history_entries.id` 从不下发 | 重连只能全量快照 + **按文本内容**做重叠合并（`lib/chat_sync.ts` 的 `comparableKey`），内容相似/重复就会错位；history 回放的 id 是位置型 `h-u-${idx}`，两次快照之间不稳定 |
| G2 | `delta` 流式增量完全不落库 | `workerPromptHandler.ts` | 断流瞬间的部分输出永久丢失；只有整轮结束的 `role:"ai"` 能补回来 |
| G3 | 重连拿到的 `history` 会被主动丢弃 | `wsMessage.ts` 中 `busy || queuedPrompts.length > 0` 的守卫直接 `return` | 恰好在忙时重连 = 完全不补同步，这是"断开后不同步"最直接的现场 |
| G4 | `task:event` 是 fire-and-forget | `webSocketHub.broadcastToSession` | 离线期间的状态迁移全丢；更糟的是 `recordToSessionHistories` 遍历**当前在线连接**来决定写哪些 history，没人在线时压根不写 |
| G5 | 聊天历史没有任何 HTTP 端点 | 全仓无 `/api/history`、`/api/messages` | WS 不通时没有任何兜底通道，恢复能力和长连接强绑定 |
| G6 | 历史 200 条硬删除 + 单条 64KB 截断 | `historyStore.trimSqlite`、`normalize` | 长会话/多端场景下服务端也真的没有记录了，不只是"没同步" |
| G7 | 没有 `visibilitychange` / `online` 触发同步 | 客户端仅有 `resize` 监听 | 移动端/切后台被 NAT 静默断开后，要等下一次退避 tick 才发现 |
| G8 | outbox 只持久化一条且丢弃带图片的 prompt，且用 `sessionStorage` | `chat.ts` 的 `savePendingPrompt` | 关闭标签页/多条排队时用户输入会丢 |

---

## 4. 目标设计

### 4.1 核心不变式

1. **服务端事件日志是唯一真相来源。** 任何前端可见的状态变化都必须先落日志再广播。
2. **每条事件有 lane 内单调递增的 `seq`。**
3. **每个浏览器标签独立保存一个 cursor（`lastSeq`），任何时刻都能用它补齐。**
4. **WS 消息允许丢失、重复、乱序**；正确性由 `seq` 和 catch-up 保证。
5. **重连的动作是 catch-up，不是全量重置。**

### 4.2 事件日志表

新增独立表，不动 `history_entries`（后者继续作为 agent 上下文来源，两者职责分离）：

```sql
CREATE TABLE IF NOT EXISTS sync_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace  TEXT    NOT NULL,
  lane_key   TEXT    NOT NULL,   -- user historyKey 或 shared::projectSessionId
  event_type TEXT    NOT NULL,   -- message | delta_snapshot | plan | command | patch | task | session_reset | in_flight
  event_id   TEXT,               -- 幂等/更新键：client_message_id、plan:<id>、exec:<key>、task:<id>
  revision   INTEGER NOT NULL DEFAULT 1,
  payload    TEXT    NOT NULL,   -- JSON，与 WS 帧同构
  ts         INTEGER NOT NULL,
  run_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_events_lane ON sync_events(namespace, lane_key, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_dedup
  ON sync_events(namespace, lane_key, event_type, event_id, revision)
  WHERE event_id IS NOT NULL;
```

要点：

- `seq` 用全局 AUTOINCREMENT，客户端只做 `seq > lastSeq` 比较，不要求连续。
- 可更新实体（plan、execute 块、task 状态、流式快照）用 `event_id + revision` 表达"同一实体的新版本"，客户端按 `event_id` upsert，这样天然解决重复与乱序。
- **payload 与 WS 帧同构**：同一条事件既能被 WS 推送，也能被 HTTP 回放，前端用同一个 reducer 处理，不需要两套代码路径。

### 4.3 写入即广播（唯一出口）

把现有散落的 `broadcastJson` / `broadcastToSession` 收敛到一个函数：

```ts
// server/web/server/sync/emit.ts
export function emitLaneEvent(args: {
  laneKey: string;
  eventType: SyncEventType;
  eventId?: string;
  revision?: number;
  payload: Record<string, unknown>;
  runId?: string;
}): number {                              // 返回 seq
  const seq = syncEventStore.append(args); // 先落库
  broadcastJsonToHistoryKey({             // 再广播，帧里带上 seq
    ...args.payload,
    seq,
  });
  return seq;
}
```

顺序必须是「先落库，后广播」。落库失败就不广播，并以 `1011 sync persistence failed` 主动关闭受影响的 WebSocket，强制客户端重连并从持久快照恢复；共享会话重置失败时必须关闭该账号与项目下的全部 lane，避免任何已被后端清空的视图继续保持陈旧在线状态。

任务侧写入项目共享 lane（`shared::<projectSessionId>`）：`webSocketHub.broadcastToSession` 在遍历在线连接之前先写 `sync_events`，因此没有客户端在线时事件也不会丢失。任务 prompt、命令和最终结果还会写入共享 history snapshot，供事件窗口截断时恢复完整终态。HTTP catch-up 会合并用户 lane 与项目共享 lane，并按全局 `seq` 排序。

### 4.4 Catch-up HTTP 接口

```http
GET /api/sync/events?sessionId=<id>&chatSessionId=<lane>&workspace=<root>&afterSeq=<n>&limit=500
```

响应：

```json
{
  "events": [
    { "seq": 10241, "type": "message", "eventId": "c-8f2a", "revision": 1, "ts": 1761... , "payload": { "...": "同 WS 帧" } }
  ],
  "latestSeq": 10310,
  "hasMore": true,
  "truncated": false,
  "snapshot": null,
  "inFlight": { "runId": "r-77", "startedAt": 1761... }
}
```

语义：

- `afterSeq=0` → 从可用起点开始（等价首屏冷启动）。
- `hasMore=true` → 客户端用最后一条的 `seq` 继续翻页，直到追平 `latestSeq`。
- `truncated=true` → 响应同时携带权威 `snapshot`；客户端以快照替换本地 lane、把 cursor 推进到 `latestSeq`，再排空期间缓存的实时事件，并给用户一个明确提示。
- 鉴权复用现有的 cookie session；lane 必须校验属于当前 `authUserId`，禁止跨用户读取。
- `sessionId=default` 必须与 WebSocket 握手使用同一规则，按已验证的 workspace root 归一化为 `deriveProjectSessionId(workspaceRoot)`。

配套：

```http
POST /api/runs/:runId/interrupt      # 中断动作的 HTTP 兜底（对应用户提到的"紧急中断后台动作"）
POST /api/sync/ack                   # 可选：上报 lastSeq，用于服务端侧的保留策略与诊断
```

### 4.5 客户端 cursor 与重连流程

cursor 存 `sessionStorage`（同一标签刷新不丢，不同标签互不推进 cursor）：

```text
ads.syncCursor.<sessionId>.<chatSessionId>  →  { lastSeq: 10241, updatedAt: 1761... }
```

重连时序：

```text
socket close
  → 标记 needsSync = true（保留本地消息，不清空）
  → 指数退避重连（保留现有 800ms→15s）
socket open（子协议携带 sessionId/chatSessionId，与现在一致）
  → welcome（携带 latestSeq、inFlight、runId）
  → 若 welcome.latestSeq > lastSeq：
       暂存 catch-up 期间到达的实时 WS 事件
       延迟处理 welcome 后紧随的无 seq bootstrap history
       do { GET /api/sync/events?afterSeq=lastSeq } while (hasMore)
       每批按 seq 顺序喂给同一个 reducer，按 eventId upsert / 按 seq 去重
       成功后按 seq 排空实时事件；失败时保持缓存且不得推进 cursor
       最后应用延迟的 bootstrap history，避免先恢复终态再重放 delta/result 产生重复回复
       lastSeq = 最后一条 seq
  → needsSync = false，恢复正常监听
  → flushQueuedPrompts()
```

同时补上触发器（修 G7）：

```ts
window.addEventListener("online", () => void ensureSynced());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void ensureSynced();
});
```

`ensureSynced()` 是幂等的：若 socket 未连则先重连，若 `lastSeq < latestSeq` 则补拉。

### 4.6 去掉内容比对式合并

有了 `seq` 和 `eventId` 之后，`lib/chat_sync.ts` 里基于 `comparableKey`（role + kind + command + 归一化正文）的重叠扫描应当退役，改为：

- 本地消息以 `eventId`（对用户消息就是 `client_message_id`）为主键，存 `Map<eventId, ChatItem>` + 有序列表。
- 收到事件：`seq <= lastSeq` 直接丢弃；否则按 `eventId` upsert（`revision` 更大者胜）。
- 位置型 id（`h-u-${idx}`）全部废弃。

同时删掉 G3 那个 `busy || queuedPrompts.length > 0` 就丢弃 `history` 的守卫 —— 它存在的原因正是"全量快照会破坏正在进行的本地状态"，而增量 catch-up 不再有这个风险。

### 4.7 in-flight 流式输出的恢复

流式 `delta` 不需要逐块落库（写放大太大），采用**节流快照**：

- 每轮开始生成 `runId`，发 `event_type=in_flight, revision=1`。
- 流式过程中每 `~500ms` 或每 `~2KB` 落一条 `event_type=delta_snapshot, event_id=run:<runId>, revision=n, payload={ text: 累积全文, done: false }`。
  用 `event_id + revision` 覆盖语义，客户端只保留最大 revision，不会重复拼接。
- 轮次结束落最终 `message` 事件（沿用现有 `role:"ai"` 落库），并把 `delta_snapshot` 标 `done: true`。
- 重连后 catch-up 自然拿到最近一次快照，UI 能续上进度条和已产出文本，不再出现"[连接中断：这段回复尚未完成]"卡死。

保留策略：整轮结束后可以只留最终快照，历史中间 revision 可清理。

### 4.8 多端一致性

- 每个端（浏览器标签/设备）各自维护 `lastSeq`，服务端**不为客户端保存同步状态**，是无状态的。这样 N 端登录天然一致，不需要 per-device 表。
- 同一浏览器多标签使用各自的 `sessionStorage` cursor。活动标签不能替挂起标签确认事件，否则挂起标签恢复时会跳过自己尚未消费的窗口。
- outbox（G8）从 `sessionStorage` 单槽改为 `localStorage` 队列，并加 `BroadcastChannel("ads-sync")` 做标签间去重，避免两个标签同时重放同一个 `client_message_id`（服务端幂等已经能兜底，但可以少一次无效往返）。

### 4.9 保留窗口

日志需要有明确的保留策略，否则 `sync_events` 会无限增长：

- 按 lane 保留最近 N 条（建议默认 2000，可配 `ADS_SYNC_EVENTS_MAX_PER_LANE`）或最近 T 天。
- 淘汰时在 `sync_lane_state.trimmed_through_seq` 记录每个 lane 实际删除到的最大 `seq`；只有 `afterSeq < trimmed_through_seq` 时才返回 `truncated: true`，避免把全局 `seq` 中属于其他 lane 的自然空洞误判为截断。
- 顺带修 G6：`history_entries` 的 200 条硬删除对 agent 上下文是合理的，但对"用户可见的聊天记录"不合理，两者拆开后前者可以更激进地裁剪，后者按上面的窗口保留。

---

## 5. 分阶段实施

### P0：先止血（不改协议，收益最大）

1. 删掉 `wsMessage.ts` 中重连 `history` 被 `busy` 守卫丢弃的分支（G3）。
2. `recordToSessionHistories` 不再依赖在线连接决定写入目标，改为按 lane 解析（G4 的一半）。
3. `onOpen` 后除了任务 resync，也无条件触发一次聊天侧同步。
4. 加 `online` / `visibilitychange` 触发重连与同步（G7）。

这一步不需要新表，就能显著降低"断开后不同步"的出现频率。

### P1：引入事件日志与 catch-up（核心）

1. 建 `sync_events` 表 + `SyncEventStore`（append / readAfter / trim）。
2. 落地 `emitLaneEvent`，把聊天与任务两条广播路径收敛进来，帧内带 `seq`。
3. 实现 `GET /api/sync/events`，`welcome` 增加 `latestSeq` / `runId`。
4. 客户端加 cursor 存储 + `ensureSynced()` 补拉循环，事件走统一 reducer。

### P2：一致性收尾

1. ❌ **未做** — 客户端消息容器改为 `eventId` 主键，退役 `chat_sync.ts` 的内容比对合并。
2. ✅ 流式 `delta_snapshot`，恢复 in-flight 续传。
3. ✅ outbox 迁移到 `localStorage` 队列 + `BroadcastChannel` 协调。
4. ✅ HTTP interrupt 兜底，WS 的 `interrupt` 降级为"更快的那条路"。
5. ✅ 保留窗口与 `truncated` 降级路径。

---

## 5.1 实现状态与偏离说明

以下几处最终实现与本文早期设计不同，以实现为准。

### 事件分级与保留窗口（对应 4.9）

单一 per-lane 窗口会被流式噪声冲爆：实测 `command` / `explored` / `delta` / `patch` 约占 94% 行数，把真正需要补齐的会话事件挤出窗口，重连于是频繁退化成 `truncated` 全量快照。现按 `server/web/server/sync/eventClass.ts` 分三级：

| 级别 | 事件 | 配额 | 裁剪后果 |
| --- | --- | --- | --- |
| `durable` | `history` / `result` / `error` / `task:event` / `delta_snapshot` 等 | `maxEventsPerLane`（默认 2000） | 推进 `trimmed_through`，客户端走 `truncated` 全量 |
| `ephemeral` | `command` / `explored` / `patch` / `workspace` | `maxEphemeralEventsPerLane`（默认 300） | 静默丢弃，**不**触发全量（`history` bootstrap 已覆盖） |
| `transient` | 逐 token 的 `delta` | 不落库 | 仅实时广播 |

### `delta_snapshot`（对应 4.7）

逐 token 的 `delta` 只做实时广播；服务端用 `sync/deltaStream.ts` 把累计文本按 750ms 节流合并成**一行** coalesced `delta_snapshot`（同 `eventId` 先删后插，因此 seq 递增，游标已越过旧行的客户端仍能收到更新）。turn 结束时该行被删除，由 `result` / `error` 与 history bootstrap 接管。客户端在 `wsMessage.ts` 用绝对文本**替换**流式块，重放幂等。

### HTTP interrupt 路径（对应 P2.4）

实际路径是 `POST /api/runs/interrupt?sessionId=…&chatSessionId=…`，不是 `/api/runs/:runId/interrupt`。本仓库的运行以 lane（`historyKey`）为单位登记在 `interruptControllers` 里，没有独立的 `runId`；且 lane key 由**认证用户 + workspace 校验过的 session** 在服务端推导，不接受客户端传入，避免越权中断他人的运行。

### outbox 存储布局（对应 P2.3）

`ads.outbox.<sessionId>.<chatSessionId>`（`localStorage`），值为 `{ pending, queued }`：`pending` 是已发出待 ack 的 prompt，`queued` 是尚未发出的队列。每次写入通过 `BroadcastChannel("ads.outbox")` 广播，同源标签页收敛到同一视图。旧的 `ads.pendingPrompt.*`（`sessionStorage`）在首次绑定时被迁移并清除。带图片的 prompt 不持久化（内存 blob 无法还原）。

### `sync/emit.ts`

未落地为独立模块，`emitLaneEvent` 的逻辑内联在两处广播出口：`ws/server.ts` 的 `appendSyncEvent` 与 `start/webSocketHub.ts`。功能等价。

### 为什么 P2.1 仍未做

退役 `chat_sync.ts` 的内容比对合并，前提是**每条历史条目有端到端稳定的标识**。目前 `history` bootstrap 的条目只有 `{role, text, ts, kind}`：`history_entries` 表虽有自增 `id`，但内存态 `HistoryEntry` 不带它，纯内存写入的条目也没有，跨重启无法保证同一条消息拿到同一个 key。因此这项要先做服务端身份改造，再重写客户端消息容器（现有按位置操作的流式 / execute / patch 逻辑都要跟着改）。规模与回归风险都大于其余 P2 三项之和，故单列，未在本轮实施。

---

## 6. 验证清单

每一项都应有自动化测试（客户端放 `client/src/__tests__/`，服务端放 `tests/`）：

- 断线 30s 期间产生 3 条事件 → 重连后本地恰好新增这 3 条，无重复无丢失。
- 断线期间任务从 `running` 变 `completed` → 重连后状态正确（当前只能靠 HTTP 全量重拉）。
- 忙碌中重连（复现 G3）→ 仍然完成补同步。
- 同一 `client_message_id` 重放 → 服务端 `duplicate`，客户端不产生第二条气泡。
- 两个标签页同时在线 → A 发消息，B 在不刷新的情况下拿到，且两者 `lastSeq` 最终一致。
- 流式输出中途断开 → 重连后续上，不留"未完成"死标记。
- `afterSeq` 落在保留窗口之外 → 返回 `truncated`，客户端走全量快照且有用户可见提示。
- 服务端重启（进程内存全丢）→ 客户端重连后仍能补齐重启前已落库的事件。

---

## 7. 明确不采纳的方案

| 方案 | 不采纳原因 |
| --- | --- |
| 自研 `UDP` / 原生 `TCP` 协议 | 浏览器无法建立原生 TCP/UDP 连接；且传输层可靠性不等于应用层可恢复性，丢的是"离线期间的事件"，换协议解决不了 |
| `WebTransport` / `QUIC` | 确实基于 UDP 且抗弱网更好，但同样不提供"断开期间事件回放"，且部署与浏览器兼容成本高。可作为 P2 之后的传输层优化，不作为同步方案 |
| 用 SSE 替换 WebSocket | 单向，无法承载 prompt / interrupt 上行，需要额外上行通道，收益不足 |
| 纯 HTTP 轮询替换 WS | 实时性与服务端负载都变差；正确做法是 WS 负责实时、HTTP 负责补齐 |
| 服务端为每个设备维护同步游标 | 引入额外状态和清理负担；客户端自持 cursor + 无状态服务端更简单也更健壮 |

---

## 8. 涉及文件速查

以下为**实际落地**的位置。

**服务端**

- `server/state/schemaMigrations.ts` — `sync_events` / `sync_lane_state`
- `server/web/server/sync/store.ts` — append / appendCoalesced / readAfterLanes / 分级 trim
- `server/web/server/sync/eventClass.ts` — durable / ephemeral / transient 分级
- `server/web/server/sync/deltaStream.ts` — `delta_snapshot` 节流合并
- `server/web/server/sync/lane.ts` / `laneRequest.ts` — lane 解析与 HTTP 侧鉴权推导
- `server/web/server/ws/server.ts` — `appendSyncEvent`（落库即广播，落库失败断连）
- `server/web/server/ws/bootstrapState.ts` / `bootstrapDelivery.ts` — `welcome` 增加 `latestSeq`
- `server/web/server/start/webSocketHub.ts` — 任务事件先落库
- `server/web/server/api/routes/sync.ts` — `GET /api/sync/events`
- `server/web/server/api/routes/runs.ts` — `POST /api/runs/interrupt`

**客户端**

- `client/src/api/ws.ts` — 帧内 `seq` 透传；`interrupt()` 返回是否发出
- `client/src/app/projectsWs/webSocketActions.ts` — catch-up 分页循环、`truncated` 降级、online/visibility 触发
- `client/src/app/projectsWs/syncSequencer.ts` — cursor、乱序缓冲、快照替换
- `client/src/app/projectsWs/wsMessage.ts` — 事件 reducer（含 `delta_snapshot` 续传）
- `client/src/app/chatStreaming.ts` — `replaceStreamingText` 绝对文本替换
- `client/src/app/outbox.ts` — localStorage 队列 + BroadcastChannel
- `client/src/app/tasks.ts` — interrupt 走 WS，失败回落 HTTP
- `client/src/lib/chat_sync.ts` — **仍在使用**，内容比对合并未退役（见 5.1）
