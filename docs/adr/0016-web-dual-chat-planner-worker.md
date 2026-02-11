# ADR-0016: Web - Dual Chat Sessions (Planner + Worker)

- Status: Accepted
- Date: 2026-02-06

## Context

在 Web UI 里，用户同时需要两种对话能力：

- **Worker**：持续执行任务（可能很长），支持 interrupt，并把执行过程实时输出到对话流。
- **Planner**：随时可用，用于讨论需求/方案/拆分任务，不应被 Worker 的执行阻塞。

如果把 Planner/Worker 复用同一个会话/同一个执行互斥，会出现典型问题：

- Worker 正在执行时，Planner 连发一句 `hi` 都会被排队到 Worker 后面，无法“并行思考/并行沟通”；
- 两类对话的历史/状态混在一起，输出串线，用户心智负担高；
- Planner 如果具备写入权限，会对“只讨论不落地”的阶段造成不必要风险。

因此需要把 Planner 与 Worker 显式拆成两条独立的会话通道，并在安全边界上做硬隔离。

## Decision

1. **WebSocket 分离为两个 chat session**
   - 同一个 project session 下，建立两条 WS 连接：
     - `chatSessionId="main"` (worker)
     - `chatSessionId="planner"`
   - 服务端通过 websocket protocols 解析 `ads-chat.<chatSessionId>` 并选择对应的 session/lock。

2. **Runtime 与会话状态隔离**
   - 前端为 Planner/Worker 各自维护独立 runtime（messages / queuedPrompts / pendingImages / busy 状态互不影响）。
   - 两条对话的历史存储、恢复也按 `chatSessionId` 分开，避免串线。

3. **安全边界：Planner 使用 read-only sandbox**
   - Planner 默认不允许写文件/执行命令（read-only sandbox）。
   - Worker 保持 `workspace-write`，用于真正落地改代码与运行命令。

4. **Codex CLI 状态隔离：Planner 使用独立 CODEX_HOME**
   - 为避免 Codex CLI/SDK 在同一 `CODEX_HOME` 下发生隐式互斥或状态冲突，
     Planner 注入独立 `CODEX_HOME`（默认 `~/.codex-planner`，可用 `ADS_PLANNER_CODEX_HOME` 覆盖）。
   - 这也允许 Planner 读取一套独立的 Codex 配置文件（例如 Search/Tool 配置）。

## Consequences

- 正向：
  - Planner/Worker 的对话通道与 UI 彻底分离，用户可以在 Worker 执行时继续与 Planner 沟通。
  - Planner 只读 sandbox 降低误写风险，更符合“讨论阶段”定位。
  - `CODEX_HOME` 隔离降低底层工具的隐式共享带来的串行/冲突概率。

- 负向/风险：
  - 成本上会增加一条 WS 连接与一套 session 管理开销。
  - 如果底层执行仍存在全局互斥（不依赖 `CODEX_HOME`），仍可能出现串行，需要进一步隔离执行器（后续工作）。

## Implementation Notes

- Frontend:
  - Dual panes + mobile drawer: `web/src/App.vue`
  - Planner runtime: `web/src/app/controller.ts`
  - Planner websocket: `web/src/app/projectsWs/webSocketActions.ts`
  - Planner prompt/interrupt: `web/src/app/tasks.ts`

- Backend:
  - Planner session manager (read-only) + lock pool: `src/web/server/startWebServer.ts`
  - WS routing by `chatSessionId`: `src/web/server/ws/server.ts`
  - Codex env override (CODEX_HOME isolation): `src/codex/codexChat.ts`, `src/telegram/utils/sessionManager.ts`, `src/codexConfig.ts`

- Reference commits:
  - `835acdd` `feat(web): add planner/worker dual chat sessions`
  - `ef4b818` `fix(web): isolate planner Codex env via CODEX_HOME`
