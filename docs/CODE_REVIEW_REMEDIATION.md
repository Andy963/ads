# ADS 代码审查问题修复方案（Remediation Plan）

**日期**: 2026-01-25  
**参考**: `docs/CODE_REVIEW.md`  
**目标**: 对 `docs/CODE_REVIEW.md` 中列出的问题逐项核验是否真实存在，并给出可落地的修复方案（含取舍、风险与验证方式），由维护者最终决策。

> 说明：本文档只描述方案与执行步骤，不强制代表最终选择。已被明确选择并落地的改动会在对应条目中标注。

---

## 1. 核验结论总览

| ID | 结论 | 备注 |
|---|---|---|
| C1 | 存在 | Web 默认绑定与鉴权行为有安全隐患；已按维护者要求将默认 host 改为 loopback |
| C2 | 存在 | workspace DB 迁移非事务，存在半升级风险 |
| C3 | 存在（多处重复） | allowlist 仅校验 basename，允许路径输入时可被绕过 |
| H1 | 存在 | orchestrator 的 `send()` 在并发切换 agent 时可能结算错 turn |
| H2 | 部分成立 | Map 不清理属实，但 auth 限制了用户集合，上界较小 |
| H3 | 存在 | workspace DB 未设置 `busy_timeout`（state DB 已设置） |
| H4 | 存在 | workspace DB cached 连接未在退出时集中关闭 |
| H5 | 存在 | Telegram fallback 日志写入原文，存在敏感信息落盘面 |
| H6 | 存在 | Web / task queue 使用 `SessionManager(0, 0, ...)` 禁用清理，存在增长风险 |
| M1 | 存在 | `.env` 向上遍历无边界，可能加载到错误配置 |
| M2 | 存在 | logger 未输出 level，降低排障可观测性 |
| M3 | 存在 | Telegram 侧 monkey-patch `ctx.reply`，依赖不安全类型断言 |
| M4 | 存在 | `classifyInput()` 每次新建 thread，成本与资源不可控 |
| M5 | 当前未触发但缺防线 | migrations 版本号一致性缺校验 |
| M6 | 存在 | Web/MCP/Telegram 部分路径将内部错误原样返回给调用方 |
| M7 | 存在 | cwd 校验用 realpath，但存储的是 resolve 后路径 |

---

## 2. 已落地的决定

### C1（部分）: Web 默认绑定改为 loopback

维护者已明确要求：默认只绑定本机 loopback，避免被误暴露到局域网/公网；如需远程访问，请通过反向代理或显式配置环境变量。

当前已落地的代码行为（`src/web/server.ts`）：

```ts
const PORT = Number(process.env.ADS_WEB_PORT) || 8787;
// SECURITY: Do NOT change this default. Keep the Web server loopback-only by default.
// If you need remote access, use a reverse proxy and/or set ADS_WEB_HOST explicitly.
const HOST = process.env.ADS_WEB_HOST || "127.0.0.1";
const TOKEN = (process.env.ADS_WEB_TOKEN ?? process.env.WEB_AUTH_TOKEN ?? "").trim();
```

> 注意：该修改只解决“默认监听范围”问题；`TOKEN` 为空时是否允许访问、以及是否对反向代理来源做额外约束，仍属于策略选择（见下文 C1 余项）。

---

## 3. 修复优先级与分阶段策略

建议分层处理，避免把“安全改动/行为变更”与“纯工程性修复”混在一次大改中。

### P0（优先修复）
- C1：Web 绑定与鉴权策略（至少要有安全默认与明确的“外部暴露开关”）
- C2：workspace DB 迁移事务化
- C3：exec allowlist 语义收敛并阻断绕过

### P1（本周内）
- H1：orchestrator 并发切换修复
- H3：workspace DB busy_timeout
- H6：Web/task queue session 生命周期治理
- M6：错误对外回显治理

### P2（按需）
- M1/M3/M4/M5/M7 与其余工程性问题

---

## 4. 逐项修复方案

### C1. Web 服务默认绑定与鉴权策略

#### 现状
- 默认 host 曾为 `0.0.0.0`，已按维护者要求改为 `127.0.0.1`。
- 代码中存在“token 为空则放行”的逻辑；如果将来有人把 host 改回全网卡或在不受控环境中部署，会导致无鉴权暴露。

#### 方案选项

**方案 A（推荐）: 保持默认 loopback + token 为空只允许 loopback**
- 默认：`127.0.0.1`
- 若 `TOKEN` 为空：只允许 `req.socket.remoteAddress` 为 loopback；否则返回 401/close
- 若需要外部访问：显式设置 `ADS_WEB_TOKEN` 并通过反向代理提供访问控制

**方案 B: 强制 token（缺失则启动失败）**
- 启动时若缺 `ADS_WEB_TOKEN` 直接退出
- 优点：最难误配
- 缺点：本机开发/内网调试成本更高

**方案 C: 仅通过文档/日志提示（不推荐）**
- 维持“token 为空放行”
- 依赖运维/反代/防火墙

#### 推荐验证

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/api/status
curl -sS -H "Authorization: Bearer $ADS_WEB_TOKEN" http://127.0.0.1:8787/api/status
```

---

### C2. workspace DB 迁移事务化

#### 现状
- `migration.up(db)` 与 `setSchemaVersion(db, ...)` 不在事务内。
- 中途失败可能导致 schema 已部分变更，但版本号未同步或反之。

#### 方案选项

**方案 A（推荐）: 单迁移事务**
- 每个 migration 用一次 transaction 包裹：`up()` 与 `setSchemaVersion()` 同事务。
- 失败时停在上一个完成版本，便于修复后重试。

**方案 B: 全量事务**
- 将所有待执行 migration 放在一个大事务里，全成全败。
- 更强原子性，但失败回滚更重。

#### 推荐验证
- 构造一个会抛错的 migration，确认失败后 schema_version 不前进且 DDL 回滚符合预期。

---

### C3. exec allowlist 绕过（basename 校验）

#### 现状
- 多处使用 `path.basename(cmd)` 做 allowlist 判定。
- 当 `cmd` 允许传路径时（如 `/tmp/git`），basename 仍是 `git`，可绕过“只允许 git”的语义。

#### 方案选项

**方案 A（推荐）: allowlist 生效时只允许简单命令名**
- 当 allowlist 非空时，要求 `cmd` 必须匹配简单模式（不含路径分隔符）。
- 将 allowlist enforcement 收敛到 `runCommand()` 内部，删除上层重复逻辑，避免未来分叉。

**方案 B: allowlist 升级为绝对路径白名单**
- allowlist 存储并匹配 realpath(absolute) 的可执行文件路径。
- 最强但配置成本最高。

**方案 C: 命令名 allowlist + 解析后路径必须位于可信目录集合**
- 例如仅允许 `/usr/bin`, `/bin` 等。

#### 推荐验证

```bash
# Expected: rejected when allowlist contains "git".
cmd=/tmp/git
```

---

### H1. HybridOrchestrator 并发切换导致 turn 结算错乱

#### 现状
- `send()` 的 `finally` 使用可变的 `this.activeAgentId`。
- `await` 期间如果切换 agent，会导致 `completeTurn()` 作用在错误的 agent 上。

#### 修复方向（推荐）
- 在 `send()` 开始时捕获 `agentId`，后续始终使用该 id。
- 或直接复用已有的 `sendOnAgent(agentId, ...)` 路径，避免重复逻辑。

---

### H2. Telegram rateLimit Map 不清理

#### 现状
- Map 不清理属实。
- 但 auth 中间件限制了 allowedUsers，Map 实际上界≈允许用户数；风险主要来自“配置允许用户非常多”的场景。

#### 修复方向（可选）
- 在窗口重置时做一次轻量清理（删除 `resetAt` 过久的条目）。
- 或引入硬上限（LRU）。

---

### H3. workspace DB 未设置 busy_timeout

#### 现状
- state DB 已设置 `busy_timeout = 5000`。
- workspace DB 缺失，可能在并发写入时更容易出现 SQLITE_BUSY。

#### 修复方向（推荐）
- 在 `src/storage/database.ts` 初始化中加入：

```ts
db.pragma("busy_timeout = 5000");
```

---

### H4. workspace DB cached 连接退出时未集中关闭

#### 修复方向
- 建议在进程入口层（Web/Bot/CLI）实现统一 graceful shutdown，并暴露 `closeAllWorkspaceDatabases()`。
- 避免在库模块中挂大量 `process.on()` 造成测试/复用副作用。

---

### H5. Telegram fallback 日志写入原文（敏感信息落盘）

#### 现状
- markdown 降级时会把原始消息全文写入 `telegram-fallback.log`。

#### 方案选项

**方案 A（推荐）: 默认不落原文，显式开关启用**
- 默认仅记录 stage、长度、hash、截断片段等调试信息。
- 通过 env 显式开启 full logging。
- 同时设置文件权限为 `0600`，并做大小上限/轮转。

**方案 B: 原文保留但做脱敏**
- 需要维护脱敏规则，且仍可能漏。

---

### H6. Web / task queue session 无清理导致增长

#### 现状
- Web 与 task queue 都使用 `SessionManager(0, 0, ...)` 禁用定时清理。

#### 方案选项

**方案 A（推荐）: 显式生命周期回收 + 兜底上限**
- WebSocket close 时销毁 session。
- task 完成时销毁对应 session。
- 追加 maxSessions + LRU 兜底。

**方案 B: 启用 SessionManager timeout 清理**
- 需要先保证长任务运行期间 `lastActivity` 语义不误判。

---

### M1. `.env` 向上遍历无边界

#### 修复方向（推荐）
- 优先支持 `ADS_ENV_PATH` 明确指定。
- 否则向上查找应有边界（例如遇到 `package.json` 或 `.git` 作为 repo root 哨兵），并限制最大层数。

---

### M2. Logger 未输出 level

#### 修复方向
- `formatMessage(level, message)` 将 level 追加到输出中。

---

### M3. Telegram ctx.reply monkey-patch 类型不安全

#### 修复方向（推荐）
- 不覆盖 `ctx.reply`；改为在 `bot.api.config.use()` 层统一注入默认参数。

---

### M4. classifyInput 每次新建 thread

#### 修复方向（推荐）
- 复用专用 classify thread，并加超时与频率限制。

---

### M5. migrations 版本一致性缺校验

#### 修复方向（推荐）
- 启动时校验 `migrations[i].version === i + 1`，不满足直接 fail fast。

---

### M6. 内部错误对外回显

#### 修复方向（推荐）
- 对外返回通用错误（可携带 requestId）。
- 详细错误仅进入日志。
- 开发模式可通过环境变量开启详细回显。

---

### M7. DirectoryManager 存储路径未 realpath 统一

#### 修复方向
- `setUserCwd()` 存储 realpath 后的结果，并考虑缓存 allowedDirs 的 realpath。

---

## 5. 统一验证清单（执行顺序）

建议在每次合并前至少跑：

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit
npm run lint
npm test
```

如修复涉及 Web 构建/前端资源，再额外跑：

```bash
npm run build:web
```
