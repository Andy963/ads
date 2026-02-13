# Web 会话标签式头部 - 设计

## 1. Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 初稿 |
| Status | Draft | |
| Authors | 未指定 | |
| Stakeholders | Web 前端、后端 | |
| Created | 2025-12-10 | |
| Last Updated | 2025-12-10 | |
| Related Requirements | req_oo7ihh9u | Web 会话标签式头部 |
| Related Implementation Plan | 待补充 | |

## 2. Context
### 2.1 Problem Statement
- 现状：头部显示“ADS Web Console”与分散的“新建/切换”按钮，session 管理体验接近单会话。
- 痛点：切换路径长、关闭后难找回；头部占用多行且信息重复。

### 2.2 Goals
- 单行头部，左“ADS”+右侧标签区，便于一眼看到多会话并快速切换。
- 图标化“+”新建、“⟳”历史，关闭标签不丢缓存，可从历史恢复。

### 2.3 Non-Goals
- 不改后端 WebSocket 协议/会话生成逻辑。
- 不新增权限/审计/国际化改造。

## 3. Current State
- Header：左侧标题+连接灯，右侧无标签条，依赖独立的新建/切换按钮与弹窗。
- Session 管理：sessionId 通过 ws 子协议传递，本地有 SESSION_HISTORY_KEY / SESSION_KEY / chat 缓存。
- Pain points：切换入口分散，关闭后恢复成本高，头部不够紧凑。

## 4. Target State Overview
- 方案：头部单行，标签式展示已打开的 session，末尾“+”新建、“⟳”历史。标签可点击切换、可关闭但不清缓存，历史入口可恢复被关闭的 session。
- 收益：切换路径缩短、空间利用更好、仍保留历史找回能力。
- 风险：标签溢出、关闭当前标签时的自动切换、历史同步一致性。

## 5. Detailed Architecture
| Concern | 描述 |
| ------- | ---- |
| 数据流 | 读取/写入 sessionStorage (SESSION_KEY) 与 localStorage (SESSION_HISTORY_KEY、per-session chat cache)。 |
| 控制流 | 标签点击触发 reconnect + 恢复缓存；关闭移除标签，若关闭当前则切到最近标签或新建；“+”新建 sessionId、清屏、重连；“⟳”弹出历史列表并可恢复。 |
| 并发/容错 | ws 关闭重连沿用现有逻辑；suppressSwitchNotice 防止重复提示；本地存取 try/catch 兜底。 |
| 可扩展性 | 标签渲染基于历史列表，可支持更多图标或命名策略。 |

### 5.1 Sequence / Flow (文字描述)
- 页面加载：读取 SESSION_KEY、历史；构建标签列表；激活 last session（若无则新建）；渲染并连接 ws。
- 点击标签：set currentSessionId → restore cache → ws 重连（带 ads-session）。
- 关闭标签：从打开列表移除；若被关闭的是当前且还有其他标签，切换到最近使用的标签；若无剩余标签，自动新建并切换。
- 点击“+”：生成新 sessionId → 追加标签并激活 → restore 缓存/重连。
- 点击“⟳”：弹出历史列表；选中项若未在标签中则追加并激活，否则直接切换。

## 6. Components & Interfaces
### C1 Header 容器
- 责任：单行布局，左“ADS”+右标签区+图标，保留连接状态指示。
- 接口：无新对外接口；内部调用标签渲染/事件绑定。

### C2 Session Tabs
- 责任：根据“打开的 session 列表”渲染标签，支持高亮、点击切换、关闭。
- 输入：openSessions[]（至少包含 currentSessionId）；历史列表做来源补全。
- 输出：onSelect(sessionId)、onClose(sessionId) 事件，驱动 connect/restore。

### C3 Controls (“+”/“⟳”)
- “+”：生成 newSessionId()、追加标签、设为当前、重连、记历史。
- “⟳”：打开历史弹窗（复用现有 session-dialog）；选择项回调 onSelect。

### C4 Session State Helpers
- 存储：SESSION_KEY、SESSION_HISTORY_KEY、cacheKey(token+session)。
- 行为：记忆当前 session、历史去重前插、最大 15 条、清屏/恢复缓存。

## 7. Data & Schemas
- openSessions（前端内存）：[{ id: string, lastActiveTs: number }]
- history（localStorage SESSION_HISTORY_KEY）：数组 { id, ts } 按时间降序，max 15。
- cacheKey：`chat-cache::<token>::<sessionId>`（沿用现有逻辑）。

## 8. Operational Considerations
### Error Handling & Fallbacks
- 本地存取失败：try/catch 静默；如无法读取历史，仍可新建默认 session。
- ws 4409（被替换）：沿用 suppressSwitchNotice 逻辑；切换时避免多余提示。
- 溢出：标签区开启水平滚动；长 ID 省略号 + title 提示。

### Observability
- 复用现有前端日志/状态提示；无需新增后端指标。

### Security & Compliance
- 不新增网络调用或敏感存储；沿用现有 token/session 传输。

## 9. Testing & Validation
- UI 行为：标签高亮切换、关闭当前后的自动切换/新建、“+”新建并重连、历史恢复行为、长 ID 省略显示。
- 状态恢复：刷新后保留上次活跃 session；关闭标签后仍可通过历史找回。
- 断网/重连：切换时 ws 重连正常，4409 提示不重复；缓存不丢失。

## 10. Release & Rollback
- 发布：前端改动，无后端 schema 变更；可与现有版本平滑切换。
- 回滚：保留旧布局代码分支，必要时 revert 前端改动即可。

## 11. Change Log
| Version | Date | Description | Author |
| ------- | ---- | ----------- | ------ |
| 0.1.0 | 2025-12-10 | 初稿 | 未指定 |
