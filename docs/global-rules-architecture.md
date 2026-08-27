# 全局规则架构计划

> **实现状态（2026-08-09）**：P0 全部落地。数据库、服务层、prompt 注入、执行 Gate（observe 模式）、Web API 与管理界面均已实现并有测试覆盖；执行 Gate 尚未切换到 enforce，且当前只观测「agent 已执行的命令」而非「执行前拦截」。逐条状态见下方各节的 ✅ / ⚠️ / ❌ 标记。

## 目标

建立一套由 ADS 统一管理的全局规则，使其同时适用于：

- ADS Web
- ADS Telegram
- Codex
- Claude

规则应具备可视化管理、审计、统一注入和执行级拦截能力。单靠 prompt 注入不能视为硬规则。

## 现状

> 以下描述的是本方案落地**之前**的状态，保留作为背景。落地后 SQLite 已成为唯一事实来源，`templates/rules.md` 仅作为 bootstrap 种子与降级 fallback。

当前规则主要来自运行时的 `templates/rules.md`。它能被 ADS 的系统提示注入，但存在以下限制：

- 规则以文件维护，没有 Web 编辑界面、版本记录或审计信息。
- workspace 的 `memory.md` 用于长期事实，受 token 上限和 workspace 隔离影响，不适合保存全局硬规则。
- Codex 与 Claude 当前都可在高权限模式下执行命令，模型即使收到规则，也可能遗漏或绕过。
- workspace 自定义 `rules.md` 有读取和展示能力，但不是当前统一 prompt 注入的可靠来源。

## 设计原则

1. SQLite 是全局规则的唯一事实来源。
2. 规则注入与规则执行分离。
3. 所有 ADS 入口和所有 agent 使用同一份启用规则。
4. 高风险操作由 ADS 执行层拦截，不依赖模型遵守自然语言。
5. 规则改动必须可追溯、可禁用、可回滚。

## 数据模型

✅ 已实现：`server/state/schemaMigrations.ts` 的 migration `version: 9`，读写封装在 `server/state/globalRuleStore.ts`。

在现有 `ADS_STATE_DIR/state.db` 中新增 `global_rules`：

```sql
CREATE TABLE global_rules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  match_json TEXT
);
```

⚠️ **相对本文档原始设计新增了 `match_json`**：Gate 需要按 `tool` / `command` 判定，而原表只有散文字段，无法机器求值。`match_json` 存放结构化匹配器：

```jsonc
{
  "agents": ["codex", "claude"],   // 作用域，留空=全部
  "channels": ["web", "telegram"], // 作用域，留空=全部
  "tools": ["shell"],              // 作用域 + 触发器
  "commandPatterns": ["\\bpkill\\b"], // 触发器，正则，大小写不敏感
  "pathPatterns": ["\\.db$"]          // 触发器，正则
}
```

`match_json` 为空、或只有 `agents`/`channels` 而没有任何触发器的规则，**只注入不拦截**——避免一条散文规则误伤所有命令。

字段约定：

| 字段 | 说明 |
| --- | --- |
| `category` | `instruction`、`safety`、`execution` 等分类 |
| `severity` | `advisory`、`required`、`approval_required`、`blocked` |
| `enabled` | 是否参与注入和执行评估 |
| `priority` | 注入和展示顺序，数字越小优先级越高 |
| `updated_by` | Web 管理员或 Telegram 管理入口的操作者标识 |

另增 `global_rule_audit_log`，记录创建、修改、启停和删除前后的内容摘要、操作者与时间。✅ 已实现：同一 migration 建表，`saveRule` / `deleteRule` 在同一事务内写入 `create` / `update` / `enable` / `disable` / `delete` 记录，`before_json` / `after_json` 保存完整快照。

## 规则生命周期

```text
Web 管理界面
  -> GlobalRuleService
  -> state.db.global_rules
  -> 规则缓存失效事件
  -> Web/TG 的 SystemPromptManager 读取并注入
  -> Enforcement Gate 在工具或命令执行前评估
```

### 规则注入

✅ 已实现：`server/rules/globalRuleService.ts` 负责渲染与缓存，`server/systemPrompt/manager.ts` 的 `resolveRules()` 负责接入。

`SystemPromptManager` 读取所有启用规则，按 `priority` 排序，渲染为：

```text
<global_rules>
...
</global_rules>
```

该区块对 Web、TG、Codex、Claude 使用同一份内容。规则变更后应立即使缓存失效，下一轮请求生效，无需重启服务。

实现细节：

- Web 与 TG 共用 `server/telegram/utils/sessionManager.ts` 的 `SessionManager`，因此两个 channel 走同一个 `SystemPromptManager` 构造路径，注入内容天然一致。
- 缓存以 `COUNT(*) + MAX(updated_at)` 作为版本指纹。Web 与 TG 是两个进程，Web 改完规则后 TG 进程在下一轮请求读到新的指纹即自动重建缓存，**不需要跨进程事件总线，也不需要重启**。
- 数据库有启用规则时，`templates/rules.md` 不再注入，避免同一条规则出现两遍。

### 执行级拦截

⚠️ 部分实现：Gate 本身已完成（`server/rules/enforcementGate.ts`），默认运行在 observe 模式；但接入点是「命令事件流」而非「执行前审批」，详见本节末尾的限制说明。

新增模型无关的 `RuleEnforcementGate`。每个待执行的工具或 shell 命令都应携带：

```ts
{
  agent: "codex" | "claude",
  channel: "web" | "telegram",
  workspace: string,
  tool: string,
  command?: string,
  userExplicitlyApproved: boolean,
}
```

Gate 返回：

- `allow`
- `require_approval`
- `deny`

处理原则：

| 规则级别 | 行为 |
| --- | --- |
| `advisory` | 仅 prompt 注入 |
| `required` | 记录并要求满足前置条件 |
| `approval_required` | 没有明确授权时阻断 |
| `blocked` | 无条件拒绝 |

例如，禁止 `pkill`、`killall`、停止 ADS 自身服务属于 `blocked`。部署属于 `approval_required`。

模式由 `ADS_RULE_ENFORCEMENT_MODE` 控制，默认 `observe`：Gate 照常计算 `decision` 并写告警日志，但返回给调用方的 `effectiveDecision` 恒为 `allow`。设为 `enforce` 后两者一致。

接入点：

- Web：`server/web/server/ws/workerPromptHandler.ts`，每条新命令评估一次，命中非 `allow` 时向聊天流推一条 `Rule` 记录。
- Telegram：`server/telegram/adapters/codex/statusUpdater.ts`，命中时写告警日志。

⚠️ **当前实现的限制（必须知道）**：Codex app-server 的 `execCommandApproval` / `item/commandExecution/requestApproval` 服务端请求在 `server/codex/appServer/rpcClient.ts` 中被当作通知处理、从不回包，Claude CLI 以 `--permission-mode bypassPermissions` 启动，两者都不向 ADS 请求逐条审批。因此现阶段 Gate 观测到的是**命令已经开始执行后的事件**，`enforce` 模式能做到「立即告警并中断本轮」，做不到「阻止该条命令启动」。要满足验收标准 3（blocked 命令绝不执行），还需要接入 Codex 的审批回包或 Claude 的 PreToolUse hook——这是后续独立一轮的工作。

Codex 的 execpolicy 仍可保留为额外防线，但不能作为唯一方案。Claude 也必须经过 ADS 的同一 Gate，避免模型或 CLI 差异导致规则失效。

## Web 管理界面

✅ 已实现：入口在顶栏「全局规则」按钮（模型管理右侧），组件 `client/src/components/GlobalRuleManager.vue`，API 在 `server/web/server/api/routes/globalRules.ts`。

在现有模型管理入口同级新增“全局规则”：

- 规则列表：标题、分类、级别、优先级、启用状态、更新时间。✅ 一行一条规则，右侧为启停开关 / 编辑 / 删除。
- 创建、编辑、启用、禁用和删除。✅ 编辑走 dialog，匹配器字段是普通字段，不折叠。
- 显示最近修改记录。✅ 面板底部展示最近 20 条审计记录。
- 预览当前最终注入给 agent 的规则文本。✅ `GET /api/global-rules/preview`。
- 提供“规则测试”面板：输入 agent、channel、tool、命令和授权状态，展示命中的规则及最终决定。✅ `POST /api/global-rules/test`，该端点固定按 `enforce` 语义求值，即使运行时仍是 observe。

API 一览：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/global-rules` | 列出全部规则 |
| POST | `/api/global-rules` | 创建规则 |
| PATCH | `/api/global-rules/:id` | 局部更新，未传字段保持不变 |
| DELETE | `/api/global-rules/:id` | 删除规则 |
| GET | `/api/global-rules/preview` | 预览最终注入文本 |
| GET | `/api/global-rules/audit?ruleId=&limit=` | 审计记录 |
| POST | `/api/global-rules/test` | 规则测试 |

写接口会校验正则可编译性，编译失败返回 400；`updated_by` 取自登录用户，不接受客户端传入。

❌ 初期 Telegram 仅消费规则。后续可增加管理员只读查询与管理命令。（当前 TG 侧只消费与观测，未提供管理命令。）

## 迁移策略

1. ✅ 为 `global_rules` 和审计表添加数据库 migration。（`version: 9`）
2. ✅ 首次启动时将现有 `templates/rules.md` 导入为一条或多条种子规则。首轮 prompt 注入时惰性触发；仅当规则表为空且未打过种子标记（`kv_state` 的 `global_rules/bootstrap_seeded`）时执行，因此手工清空规则不会被重新灌回。模板中的「数据库文件保护」「提交策略」「进程自保」三条会带上可执行匹配器导入，另加一条「部署需显式授权」。模板不可读时不种任何规则。
3. ✅ 保留 `templates/rules.md` 作为数据库不可用时的只读 bootstrap fallback。降级时注入文本带 `[degraded]` 前缀并写一次告警。
4. ✅ 改造 `SystemPromptManager`，优先读取数据库规则。
5. ✅ 先以 observe 模式运行 Enforcement Gate，只记录本应拦截的动作。（默认 `ADS_RULE_ENFORCEMENT_MODE=observe`）
6. ❌ 验证命中率后，对 `blocked` 和 `approval_required` 正式启用拦截。（待观测数据积累；且受上文「执行级拦截」的限制约束）
7. ⚠️ 为 Web、TG、Codex、Claude 编写覆盖一致性的集成测试。单元测试已覆盖 store / service / gate / API / 界面（`tests/rules/globalRules.test.ts`、`tests/web/globalRuleRoutes.test.ts`、`client/src/__tests__/global-rule-manager.test.ts`）；跨 channel 端到端集成测试尚未编写。

## 与记忆系统的边界

`memory.md` 继续保存 workspace 级的稳定事实和项目决策，例如技术栈、下载目录和已确认接口约定。它不用于硬规则：

- memory 是 workspace 隔离的。
- memory 有 token 上限，旧内容会被裁剪。
- memory 的语义是“供模型参考”，不是“执行系统必须拒绝”。

若后续引入 Mem0 等向量记忆层，应把它作为 `memory.md` 的提取、检索和归纳增强层，不替代全局规则数据库或执行 Gate。

## 验收标准

1. ✅ Web 与 TG 在同一时刻读取到同一版本的启用规则。（同一份 `state.db`，缓存按版本指纹失效）
2. ✅ Codex 与 Claude 的 prompt 都包含相同的 `<global_rules>` 区块。（同一个 `SystemPromptManager`，与 agent 无关）
3. ❌ 被标记为 `blocked` 的命令，无论来自哪个 channel 或 agent，都不会执行。当前只能在命令事件到达时告警；真正的执行前拦截取决于 Codex 审批回包 / Claude PreToolUse hook 的接入，见「执行级拦截」一节。
4. ✅ Web 可以查看、编辑、启停规则并追溯修改记录。
5. ✅ 规则改动在下一轮请求生效，不需要部署或重启。
6. ✅ 数据库故障时，系统明确降级到只读 bootstrap 规则并记录告警。
