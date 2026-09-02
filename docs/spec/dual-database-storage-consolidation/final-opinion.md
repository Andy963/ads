# ADS 双库存储收敛最终意见

- **评审对象**：`requirements.md`
- **评审依据**：`ads-dual-db-consolidation-assessment.md`
- **评审基线**：`dev @ 26f13b9`，2026-08-30
- **最终状态**：有条件通过架构方向；当前 Draft 不批准直接实施

## 一、最终结论

双库收敛的总体方向是正确的，值得继续推进：保留 `state.db` 作为全局控制面和高频同步热流，将任务、调度、附件、会话及其全文索引集中到 `workspaces.db`，并通过 `workspace_id` 实现逻辑隔离。该方向能够同时改善跨项目聚合能力和高频 `sync_events` 对业务库写入的锁竞争。

但是，当前 `requirements.md` 不是可以直接交给 Worker 执行的实施规范。评估报告已经证明其中存在会导致返工或静默丢数据的硬缺口，因此本轮决策为：

> **批准继续设计，不批准按现稿编码。先修订规范并通过迁移演练，再进入实现阶段。**

这里的“有条件通过”是对目标架构的认可，不是对当前 schema、迁移 SQL 或测试方案的批准。

## 二、保留的设计决策

以下决策与代码现状和业务目标一致，应保留：

1. 使用固定的 `state.db + workspaces.db` 双库模型。
2. 将 `sync_events` 等高频控制面数据与任务、附件、调度等结构化业务数据物理分离。
3. 在业务表中增加 `workspace_id`，所有访问路径都进行 workspace 约束。
4. 复用现有 `deriveWorkspaceStateId` 的稳定 workspace 标识规则，不以裸目录名或可变绝对路径作为长期标识。
5. 保留 WAL 和 `busy_timeout` 配置，并将 central business database 设计为进程内单例连接。
6. 先治理测试状态目录污染，再实施数据收敛；否则无法区分迁移问题和测试残留问题。
7. 迁移必须幂等、可审计、可回滚，并覆盖生产环境中同时运行的 `ads-web` 与 `ads-tg`。

需要修正的一点是：双库并不等于只保留一套 migration 文件。`state.db` 和 `workspaces.db` 是不同数据库，仍然需要各自维护与自身 schema 对应的 migration；真正要消除的是每个 workspace 独立 `ads.db` 的动态连接、重复迁移和多库 fan-out。

## 三、必须先修订的阻断项

### 3.1 Schema 必须以真实 DDL 为唯一来源

现稿 §3 的表结构不能作为目标 schema。评估报告已确认：

- `tasks` 实际列数和业务字段明显多于现稿，现稿漏掉 prompt、model、model 参数和 goal 字段，并写入了不存在的 `review_notes`、`review_rating`；
- `attachments` 的实际字段是 `content_type`、`size_bytes`、`storage_key`，不是现稿中的 `mime_type`、`byte_size`、`storage_path`；
- `task_runs` 实际使用 `id`、隔离信息、工作区路径、head 信息、capture/apply 状态等字段，现稿的 `run_id`、`error_text` 等不匹配；
- `task_contexts` 是 `context_type/content` 结构，不是现稿的 key-value 结构；
- `conversations`、`conversation_messages` 还包含现稿未列出的 token、model、metadata、status 等字段；
- 现有表清单还包括 `model_configs`、review 相关表、FTS 辅助表和 `schema_version`，现稿没有给出完整处置方案。

修订要求：从 `server/storage/migrations.ts` 的最新有效 DDL 机械生成目标 schema，再逐表增加 `workspace_id` 和必要的复合索引。不得依据现稿重新手写一个“近似 schema”。目标 schema 评审必须能逐列映射到现有 store、scheduler、attachment、skills 和 API 代码。

### 3.2 唯一约束必须显式决策，迁移禁止静默忽略

现稿的 `INSERT OR IGNORE` 不可接受。至少以下冲突已经被评估确认：

- `attachments.sha256` 当前存在不带 workspace 维度的全局唯一语义；
- `schedule_runs.external_id` 当前存在不带 workspace 维度的唯一约束；
- 多个旧库合并后，这些值可能跨 workspace 重复；`OR IGNORE` 会把冲突行静默丢掉。

修订后的规范必须为每个唯一约束给出业务决策：

- 若唯一性应限定在 workspace 内，改为 `(workspace_id, value)`；
- 若唯一性必须全局保持，迁移器必须建立冲突报告并在冲突时 fail-fast，由人工决定合并或改写；
- 对附件应明确“跨 workspace 同 hash 是否允许多行、是否可共享同一个物理对象、删除引用如何处理”；
- 对 `external_id` 应明确其生成方、重试语义和跨 workspace 唯一性边界。

迁移实现必须先执行冲突检测，再执行数据写入；任何未决冲突都不得通过 `IGNORE`、覆盖或隐式去重处理。

### 3.3 所有 SQL 访问必须完成 workspace 审计

给出两条示例 SQL 不足以保证隔离。必须对 `storeStatements.ts` 及相关 store 的全部 prepared statement 逐条审计，特别是：

- 按 `id` 读取、更新或删除任务的语句；
- `queue_order` 的 `MAX()` 取号和队列状态更新；
- task plan、message、run、context 的关联查询；
- schedule lease、schedule run 和 attachment 去重；
- conversation 与 FTS 查询、触发器和回填语句。

每条语句都必须明确属于以下之一：带 workspace 条件、只操作全局表、或仅在迁移/维护事务中使用。任何依赖全局 `id` 偶然唯一而不校验 workspace 的业务查询，都视为隔离缺陷。

### 3.4 测试沙箱方案必须匹配真实测试框架

现稿提出新的 `tests/helpers/testStateDir.ts` 和 Vitest 全局生命周期，但服务端实际通过 `scripts/run-tests.js` 使用 `node --test`；同时仓库已有 `tests/helpers/adsStateDir.ts`，已经提供临时 `ADS_STATE_DIR`、锁和清理能力。

最终方案应改为：

1. 扩展现有 helper，不重复创建同类设施；
2. 让会触发 workspace 检测、数据库创建或状态路径解析的服务端测试统一进入临时状态目录；
3. 明确 node test runner 下采用显式 `beforeEach/afterEach` 或测试辅助封装，不假设不存在的全局 Vitest hook；
4. 增加可观测验收：完整后端测试结束后，仓库 `.ads/workspaces` 和正式 `ADS_STATE_DIR` 不得新增测试目录；
5. 并发测试必须使用独立临时目录，避免通过全局环境变量互相污染。

测试污染的根因不只是数据库连接未隔离，还包括临时 workspace 创建时未设置 `ADS_STATE_DIR`。修订必须覆盖这两类入口。

### 3.5 表级处置必须写入规范

迁移器不能只按“现稿列出的表”搬运。必须增加表级处置表，至少包括：

| 表/对象 | 当前事实 | 修订时必须决定 |
|---|---|---|
| `tasks`、`task_plans`、`task_messages`、`task_runs`、`task_contexts` | 活跃任务域 | 迁移并增加 workspace 隔离 |
| `schedules`、`schedule_runs` | 活跃调度域 | 迁移并决定 lease、external_id 的唯一性 |
| `attachments` | 活跃附件域 | 迁移并明确 hash、存储键和引用删除语义 |
| `conversations`、`conversation_messages` | 活跃会话域 | 迁移并保留完整字段、外键和 workspace 条件 |
| `model_configs` | 存在活跃 CRUD API | 明确放在 state 还是 workspaces，不能因生产当前 0 行而遗漏 |
| `review_snapshots`、`review_queue_items`、`review_artifacts` | 有 schema/外键，当前未发现运行时读写方 | 明确迁移、废弃或保留；若废弃需独立清理方案 |
| `task_messages_fts` 及相关触发器 | 有触发器，当前查询使用情况需复核 | 明确重建、迁移或废弃，不能只迁基础表 |
| state 库中的遗留 `tasks`、`task_messages` | writer 已删除的遗留对象 | 明确不迁移，并保留审计记录 |
| `schema_version` | 迁移版本元数据 | 明确 central DB 的版本初始化和升级策略 |

这张表应在实施规范中落成“迁移/不迁移/废弃 + 理由 + 验证方式”的确定清单。

## 四、推荐的修订后实施路线

### Phase 0：冻结基线与测试止血

- 固定当前 state/workspace 数据库、表、索引、触发器和行数快照；
- 扩展既有测试沙箱 helper，先消除正式状态目录新增垃圾；
- 清理历史 2231 个无主测试目录前，先枚举、确认归属并保留必要备份；
- 增加测试结束后的目录污染断言；
- 不修改生产数据库内容，不在本阶段删除未知目录。

### Phase 1：冻结真实 schema 与语句审计

- 从最新 migration DDL 生成 central schema；
- 完成表级处置清单；
- 完成所有 store/scheduler/attachment/FTS SQL 的 workspace 审计；
- 对每个唯一索引、外键、触发器、FTS rowid 和存储路径给出确定语义；
- 先通过类型检查、静态 SQL 检查和 fake database 单测。

### Phase 2：实现 central database，但不自动迁移生产数据

- 新增单例 `workspaces.db` 连接和明确的 `workspaceId` 注入；
- 保留必要的旧 API 兼容层，但禁止新代码继续按 workspace 打开独立数据库；
- 为所有业务读写增加 workspace 条件；
- 在临时复制数据上运行完整 CRUD、FTS、调度 lease、附件生命周期和跨 workspace 隔离测试；
- 此阶段不自动改名旧库、不删除旧库、不切换生产服务。

### Phase 3：迁移器与演练

- 使用受控的 workspace 目录清单，而不是无约束地猜测目录名；
- 迁移前执行 schema、外键、唯一冲突和附件文件存在性检查；
- 每个旧库在独立事务中导入，成功后记录源库标识、行数校验和 hash/统计摘要；
- 目标库写入后执行行数、关键字段、外键、FTS 搜索和跨 workspace 隔离校验；
- 只有全部 workspace 成功且审计记录完整，才允许标记迁移完成；
- 任何错误都 fail-fast，不得部分成功后写全局完成标志。

### Phase 4：灰度切换与回滚窗口

- 先在复制的生产数据上完成至少一次完整迁移演练和回滚演练；
- 生产切换时使用跨进程锁，防止 `ads-web` 和 `ads-tg` 同时执行迁移；
- 切换前暂停会产生业务写入的入口，或设计明确的写入闸门；
- 旧 `ads.db` 只能在校验完成后以可恢复方式归档，不得直接删除；
- 回滚方案必须处理新库已产生的增量：要么导出并回灌增量，要么明确暂停写入并限定回滚窗口；
- 迁移完成标记必须在所有校验完成后写入，并具备版本、源库集合和目标库校验摘要。

### Phase 5：稳定后清理动态分库代码

- 观察 central DB 的锁等待、错误率、任务/调度/附件读写和 FTS 延迟；
- 确认所有运行时入口都使用 central DB 后，再移除动态路径缓存和旧分库兼容层；
- 清理旧 migration 或遗留表必须单独列出变更，不与首次数据迁移混为一个不可逆步骤；
- 完成文档、监控、备份和恢复手册同步。

## 五、最终验收门槛

修订后的 delivery spec 至少必须满足以下条件，才能重新进入实现：

1. 目标 schema 可由当前真实 DDL 逐列映射，且无虚构列、漏列或错误列名。
2. 所有业务 SQL 的 workspace 隔离审计完成，包含无 `WHERE` 的聚合和批量更新语句。
3. 所有跨库唯一冲突都有业务决策；迁移器不存在 `INSERT OR IGNORE` 静默丢数据路径。
4. 所有现有表、FTS、触发器、遗留表和 `model_configs` 都有明确处置结论。
5. 测试方案使用真实的 node test runner 和既有 sandbox helper，并能证明正式状态目录无新增测试残留。
6. 迁移具备并发互斥、幂等审计、行数/外键/FTS 校验和可执行回滚方案。
7. 回滚窗口的数据增量处理方式已经明确并经过演练。
8. 代码实现完成后必须运行仓库规定的 lint、类型检查、后端测试、前端测试和构建；迁移相关测试不得依赖真实生产数据库或网络。

## 六、最终意见

**建议接受该项目目标和总体架构，但退回当前 `requirements.md` 进行一次规范级修订。**

修订重点不是继续扩写愿景，而是把真实 schema、唯一性语义、表级处置、全量 SQL 审计、测试沙箱和迁移/回滚协议写成可执行的确定规则。完成这些修订并通过临时数据演练后，再批准 Worker 实施；在此之前直接编码会把 schema 偏差和数据冲突风险带入生产迁移，不符合无损收敛目标。
