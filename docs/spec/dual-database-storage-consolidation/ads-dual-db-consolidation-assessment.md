# ADS 双库存储收敛（Dual-Database Storage Consolidation）可行性评估报告

- **评估对象**：`docs/spec/dual-database-storage-consolidation/requirements.md`（342 行，Draft）
- **评估基线**：ads 仓库 `dev @ 26f13b9`（2026-08-30）
- **评估方式**：只读。全文核对文档五个章节与 server/storage、server/tasks、server/scheduler、server/attachments、server/skills、server/workspace、tests 的真实代码，并直接检查生产机上两处状态目录的真实数据分布
- **评估结论**：**有条件可行**——方向正确、痛点真实、阶段划分合理；但 Schema 章节与真实代码偏差严重（按现稿实施会静默丢数据），测试沙箱章节与现状脱节，需修订后再实施

---

## 一、执行摘要

该需求文档要解决三个问题：①测试在正式状态目录产生 2231 个垃圾 workspace 目录；②storage/state 两套 migration 并存、每 workspace 各自一个 ads.db 各自跑迁移；③任务数据分散在 N 个 SQLite 文件，无法跨项目 SQL 聚合。目标架构为固定双库：state.db（控制面+sync_events 热流）+ workspaces.db（全部工作区业务表，按 workspace_id 列隔离）。

**核实结果**：三个痛点全部真实存在（数据见第二节），动静分离的设计判断正确（sync_events 实测占 state.db 体积 86%），`workspace_id` 列隔离方案与现有 `deriveWorkspaceStateId` 机制兼容，五阶段实施顺序合理（沙箱化先行是正确的止血顺序）。

**但文档存在四类必须修订的问题**：
1. **§3 Schema 是"凭印象重写"而非"现有 schema + workspace_id"**：tasks 表文档列 20 列、真实 36 列（漏 prompt/model/goal_* 等 16+ 列，且 review_notes/review_rating 两列在真实库中不存在，真实列名是 review_snapshot_id/review_conclusion/reviewed_at）；attachments 列名错（mime_type/byte_size/storage_path → 真实 content_type/size_bytes/storage_key）；task_runs、task_contexts、conversations、conversation_messages 均有结构性错误。
2. **UNIQUE 约束在合库时的跨 workspace 冲突未处理**：`idx_attachments_sha256`（全局 sha 去重）和 `idx_schedule_runs_external_id` 两个 UNIQUE 索引都不带 workspace_id，多库合并后必然撞约束；而 §5 迁移策略用 `INSERT OR IGNORE`，冲突时会**静默丢数据**。
3. **§6 测试沙箱章节与现状脱节**：文档要新建的 `testStateDir.ts` 与现有 `tests/helpers/adsStateDir.ts`（installTempAdsStateDir，已做 ADS_STATE_DIR 隔离 + 文件锁 + 清理）功能重复；且写的是"Vitest 全局生命周期"，而服务端测试实际用 **node --test**（scripts/run-tests.js），不存在全局生命周期钩子；污染根因也不是"数据库没隔离"（17 个数据库测试里 16 个已用 ADS_DATABASE_PATH 指向 tmpdir），而是**测试内创建临时 workspace 的路径**（web ws workspace、memory 等）。
4. **遗漏表的处置未交代**：model_configs（有完整 CRUD API 但生产全 0 行）、review_snapshots/review_queue_items/review_artifacts（有 schema 有外键、无任何运行时读写方）、task_messages_fts（有触发器、无查询方）、state.db 里的 vestigial tasks/task_messages 表（writer 已在 0a7293a 被删除）。

---

## 二、文档主张 vs 代码现状对照清单

| # | 文档主张 | 代码/数据实测 | 判定 |
|---|---|---|---|
| 1 | state.db 约 29.24MB，sync_events 占 80%+ | 实测 30.66MB；dbstat：sync_events 26.4MB（86%） | ✅ 一致 |
| 2 | 每 workspace 一个 ads.db 存任务/调度/附件/FTS | 10 个真实 ws 各有 ads.db（272K-552K），表清单吻合 | ✅ 一致 |
| 3 | 状态目录是 `$ADS_STATE_DIR (~/.local/state/ads/)` | 代码默认 `PROJECT_ROOT/.ads`（adsPaths.ts:30）；`~/.local/state/ads` 仅由 scripts/deploy-local.js:16 显式设置；生产机两处并存，**2231 个测试垃圾目录在 repo/.ads/workspaces**，文档未提 | ⚠️ 部分准确 |
| 4 | 测试产生 1900+ 无主残余目录 | 实测 repo/.ads/workspaces 共 2231 个（命名如 ads-web-ws-workspace-mDoE6U-*），全为标准 slug-hash 命名 | ✅ 一致（位置文档没说清） |
| 5 | 污染根因 = 单测未完全隔离 ADS_STATE_DIR | 数据库测试已普遍设 ADS_DATABASE_PATH→tmpdir（taskStore/taskQueue/images/schedulerStore 等测试第 19/35/114/19 行）；污染来自**临时 workspace 创建路径**（未设 ADS_STATE_DIR 时落 PROJECT_ROOT/.ads）；现有隔离 helper installTempAdsStateDir 仅 15 个文件使用 | ⚠️ 根因诊断不准 |
| 6 | 双套 migration 并存 | server/state/schemaMigrations.ts（11 个，state.db）+ server/storage/migrations.ts（25 个，ads.db） | ✅ 一致 |
| 7 | WorkspaceDatabase 用 WeakMap/动态路径缓存 | 实为 `cachedDbs: Map<string, DatabaseType>`（database.ts:12），无 WeakMap；细节不准但问题真实 | ⚠️ 细节偏差 |
| 8 | 跨项目聚合受限 | tasks 分散 10 个库（共 10 个任务、多为 0-3 行），SQL 无法跨库聚合 | ✅ 一致 |
| 9 | §3 tasks 表 schema（20 列，含 review_notes/review_rating） | 真实 36 列；review_notes/review_rating 不存在，真实为 review_snapshot_id/review_conclusion/reviewed_at；漏 prompt/model/model_params/goal_* 等 16+ 列 | ❌ 严重偏差 |
| 10 | §3 attachments（mime_type/byte_size/storage_path） | 真实 content_type/size_bytes/storage_key（另有 width/height/filename） | ❌ 错误 |
| 11 | §3 task_runs（run_id/model_id/error_text） | 真实 id/execution_isolation/workspace_root/worktree_dir/branch_name/base_head/end_head/capture_status/apply_status/error——**已有 workspace_root 列** | ❌ 错误 |
| 12 | §3 task_contexts（context_key/context_value KV） | 真实 id/task_id/context_type/content | ❌ 错误 |
| 13 | §3 conversations/conversation_messages 列清单 | 漏 total_tokens/last_model/model_response_ids/status 与 model_id/token_count/metadata/task_id | ⚠️ 不完整 |
| 14 | §3 schedules/schedule_runs | 列清单与真实一致 | ✅ 一致 |
| 15 | 文档表清单完整覆盖现有数据 | 遗漏 model_configs（storeImpl/modelConfigOps.ts 有完整 CRUD）、review_snapshots/review_queue_items/review_artifacts（schema 存在、无运行时读写方）、task_messages_fts（有触发器无查询方）、schema_version | ❌ 遗漏 |
| 16 | §4.4 FTS 查询改造 SQL | 与现有 builtinTools.ts:82-92 基本同构，加 workspace 过滤，方向正确 | ✅ 可行 |
| 17 | §5 迁移用 INSERT OR IGNORE + 改名 .bak + kv_state 标记 | 流程可行；但 UNIQUE 索引（attachments.sha256、schedule_runs.external_id，均不带 workspace_id）跨库合并必撞约束，OR IGNORE 会**静默丢行** | ❌ 有丢数据风险 |
| 18 | §5 workspace_id 取目录名 | deriveWorkspaceStateId 已有同构函数（adsPaths.ts:37），可复用 | ✅ 可行 |
| 19 | §7 WAL + busy_timeout=5000 | 现有 getDatabase 相同配置（database.ts:159-166） | ✅ 一致 |
| 20 | §7 回滚 = 切回旧版本 + 恢复 .bak | 逻辑自洽；但"迁移后至回滚前"期间写入 workspaces.db 的增量会丢，文档未提 | ⚠️ 需补充 |
| 21 | §6 新建 testStateDir.ts + "Vitest 全局生命周期" | 已有 tests/helpers/adsStateDir.ts（含文件锁/进程存活检测/清理）；服务端测试框架是 node --test（scripts/run-tests.js:32），无全局生命周期；vitest 仅 client 侧 | ❌ 与现状脱节 |
| 22 | §8 Phase 5 重启用户级 systemd | deploy-local.js 确装 ads-web.service/ads-tg.service（systemctl 确认 running） | ✅ 一致 |

---

## 三、可行性结论

**三个问题的直接回答**：

1. **是否可行？** 有条件可行。架构方向（双库 + workspace_id 列隔离 + 动静分离）与代码库现实兼容，迁移量极小（10 个 ws 共约 3.4MB 业务数据，ATTACH+INSERT 秒级完成），回滚路径自洽。
2. **是否合理？** 大方向合理，三处不合理：a) §3 Schema 应从 `storage/migrations.ts` 现有 DDL 生成而不是手写（当前稿若照抄实施，建出来的表装不下现有代码要写的列）；b) 跨 workspace 的 UNIQUE 语义变化未讨论——attachments 的 sha256 全局去重改成 (workspace_id, sha256) 后，同一文件在不同 workspace 会存两份（存储语义变化），不改则迁移撞唯一索引；c) 测试沙箱章节应该基于现有 helper 扩展，而不是新建重复设施、更不是引用不存在的"Vitest 全局生命周期"。
3. **能否达到预期目标？** 修订后可以。目标①测试污染：可达成，但要注意真正污染源是临时 workspace 创建路径（凡是会调 detectWorkspaceFrom/resolveWorkspaceStatePath 的测试都要进沙箱），只隔离数据库连接不够。目标②migration 收敛：部分达成——per-workspace 重复跑迁移的问题消除，但 state/schemaMigrations.ts 与 storage/migrations.ts 两套文件依然并存（它们服务两个不同的库），文档"解决双套 Migration 复杂度"的表述偏乐观。目标③跨项目聚合：完全达成，且是三个目标中收益最确定的。

---

## 四、风险与缺口清单（按影响分级）

**高**：
- H1. UNIQUE 索引 × INSERT OR IGNORE = 迁移静默丢数据（attachments.sha256、schedule_runs.external_id）。修复：文档 schema 需显式决定每个 UNIQUE 索引是否携带 workspace_id；迁移器应先统计冲突、有冲突即 fail-fast 而非 IGNORE。
- H2. §3 Schema 与真实 DDL 的偏差（tasks 36 列 vs 20 列等）。若照文档建表，Phase 3 改造 storeStatements 时会发现列对不上，返工不可避免。修复：以 migrations.ts 最新版本的 DDL 为基准，仅做"加 workspace_id + 调整主键/索引"的机械变换。
- H3. queue_order 全局取号语句 `SELECT COALESCE(MAX(queue_order),0)+1 FROM tasks`（storeStatements.ts:95-97）等"无 WHERE 的聚合/UPDATE"语句在合库后会产生跨 workspace 串扰，§4 只给了两条示例语句，未要求全量审计。修复：对 storeStatements.ts 全部 ~40 条语句做逐条标注（本次评估抽查已发现 getTaskStmt/listTasks/selectNextQueueOrderStmt/queue 状态更新等多处需加 workspace_id）。

**中**：
- M1. 回滚窗口数据丢失：迁移上线后到发现问题回滚之间，新写入 workspaces.db 的任务/附件只在新区，恢复 ads.db 后不可见。建议回滚方案补"导出 workspaces.db 增量"步骤或明确接受丢失窗口。
- M2. 遗留表处置未交代：review_* 三表（无读写方）、task_messages_fts（无查询方）、state.db 的 tasks/task_messages（writer 已随 commit 0a7293a 删除）、model_configs（ads.db 侧 API 还活着但 state.db 侧也有同名表且是真正的活跃表）。合并时应明确"迁、不迁、还是顺手删"，否则垃圾表原样搬进新库。
- M3. 附件存储路径：storage_key 现在按 workspace 目录约定存放（taskOps.ts:442 删除任务时要按 storage_key 清文件），合并后 storage_key 的路径约定是否变化，文档未提。
- M4. 两个长期运行的 systemd 服务（ads-web/ads-tg）共享同一 state 目录，迁移代码必须处理"两个进程同时启动、同时触发回填"的并发（现有 migrateLegacyWorkspaceAdsIfNeeded 的 rename 原子性可以借鉴）。

**低**：
- L1. FTS5 的 workspace_id UNINDEXED 列过滤是全扫过滤，量大后可考虑把 workspace 维度拆成独立列或分区；当前数据量（363 行）完全不是问题。
- L2. 文档把 WeakMap 写成连接缓存实现细节（实为 Map），修订时顺手更正即可。

---

## 五、改进建议（按优先级）

1. **重写 §3**：以 `server/storage/migrations.ts` 的最终版 DDL 为唯一基准生成目标 schema，逐表加 `workspace_id TEXT NOT NULL` 与复合索引；每个 UNIQUE 索引单独决策（建议 attachments 去重改为按 sha256 查询复用 + 允许跨 ws 多行，schedule_runs.external_id 改为 (workspace_id, external_id) 唯一）。
2. **重写 §6**：不新建 helper，扩展现有 `tests/helpers/adsStateDir.ts`；把 17 个直接使用数据库的测试文件统一接入；明确 node --test 无全局钩子，用"约定 + CI 检查（测试结束后断言 .ads/workspaces 无新增目录）"兜底。真正的验收标准应该是：跑完全量测试后 repo/.ads 与 ADS_STATE_DIR 下无新目录。
3. **§5 迁移器加 fail-fast**：ATTACH 后先跑冲突检测查询（按新 UNIQUE 约束逐表 COUNT 冲突行），任何冲突即中止并报告，绝不静默 IGNORE。
4. **补一节"表级处置清单"**：现存每张表标注 迁移/不迁移/废弃，特别是 model_configs、review_*、task_messages_fts、state.db 的 tasks/task_messages。
5. **§4 增加语句级改造清单**：storeStatements.ts 全部 prepared statement 逐条标注是否需要 workspace_id（本次抽查确认 selectNextQueueOrderStmt、getTaskStmt、queue 状态更新等均需改造）。
6. 顺手清理：Phase 4 完成后把 2231 个测试垃圾目录和 repo/.ads/workspaces 一起清掉（这是本次评估实测发现的最大存量垃圾，文档 §1 的数字已经过时）。

---

## 六、引用文件清单（供独立复核）

| 文件 | 关键位置 | 说明 |
|---|---|---|
| server/storage/database.ts | :12 cachedDbs、:148 getDatabase、:159-166 WAL/busy_timeout | 现有连接管理与文档描述的差异 |
| server/storage/migrations.ts | :41 tasks、:200 attachments、:286 schedules、:370 review_*、:476/:552 task_runs、:644 task_messages_fts | 真实 DDL（§3 的正确基准） |
| server/state/schemaMigrations.ts | :14 baseline、:55 tasks(不同构)、:235 history_session_links、:258 sync_events | state.db 真实 DDL 与 vestigial 表 |
| server/workspace/adsPaths.ts | :25 resolveAdsStateDir、:37 deriveWorkspaceStateId、:156 ads.db 迁移对 | 默认目录是 PROJECT_ROOT/.ads；workspace_id 生成可复用 |
| server/workspace/detector.ts | :199 getWorkspaceDbPath、:209 ads.db 空文件创建 | ads.db 创建点（测试垃圾来源之一） |
| server/tasks/storeStatements.ts | :59/:93-100/:116-197 语句、:95 queue_order 全局取号 | 逐条需加 workspace_id 的改造对象 |
| server/tasks/storeImpl/taskOps.ts | :154 randomUUID、:442-446 删除联动 | 主键全局唯一性（合库后仍唯一，不冲突） |
| server/attachments/store.ts | :44/:82-140 sha256 去重语义 | UNIQUE 跨 ws 冲突点 |
| server/skills/builtinTools.ts | :72-92 searchSessionMessages | §4.4 的改造基准 |
| server/web/server/taskQueue/context.ts | :29-36 | task queue 的 store/attachment 装配点 |
| scripts/deploy-local.js | :16 stateDir、:187 systemd env | ~/.local/state/ads 的真正来源 |
| tests/helpers/adsStateDir.ts | 全文 | 现有沙箱 helper（§6 应复用它而非新建） |
| scripts/run-tests.js | :32 node --test | 测试框架事实（非 Vitest） |
| tests/tasks/taskStore.test.ts 等 17 文件 | ADS_DATABASE_PATH 用法 | 测试隔离现状与污染根因 |
| 生产数据 | repo/.ads/workspaces 2231 目录；~/.local/state/ads/workspaces 10 个 ads.db 共约 3.4MB；state.db 30.66MB（sync_events 26.4MB） | 痛点量化 |

---

## 七、评估过程说明

- 全程只读：ads 仓库 git status 在评估前后均为 `?? docs/design/`、`?? docs/spec/dual-database-storage-consolidation/` 两个 untracked 目录（文档作者产生，非本次评估产生），无任何 tracked 文件改动；数据库仅以只读方式打开（python sqlite3 SELECT/PRAGMA），无写入。
- 数据快照时间：2026-08-30 20:00-21:00 (GMT+8)。
