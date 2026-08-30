# Implementation Notes

本文记录双库存储收敛在当前代码中的落地边界，作为 requirements.md 与 final-opinion.md 的执行补充。

## 已落地

- workspaces.db 通过 getWorkspacesDatabase() 使用单例连接，默认位于 ADS_STATE_DIR/workspaces.db，保留 ADS_DATABASE_PATH 作为显式测试或运维覆盖。
- 任务、计划消息、上下文、运行实例、调度、调度运行、附件、会话、review 表增加 workspace_id，所有 Store 查询、更新和删除均带 workspace 条件。
- 附件哈希唯一性收敛为 (workspace_id, sha256)；调度运行幂等键收敛为 (workspace_id, external_id)，跨 workspace 可重复。
- 业务表引用由数据库触发器校验父子行 workspace_id 一致，拒绝跨 workspace 的任务消息、运行记录、附件、调度运行、会话与 review 引用。
- Hermes 会话检索按 workspace 过滤；正式 Web/Telegram runtime 的 model_configs 继续由 state.db 的 GlobalModelConfigStore 负责。TaskStore 暴露的旧 model-config 方法仅保留兼容用途，不应作为正式 runtime 的写入入口。
- 后端测试 runner 使用一次性 ADS_STATE_DIR、ADS_STATE_DB_PATH 和 ADS_WORKSPACES_DATABASE_PATH，并串行运行 node --test，避免状态目录污染和共享连接竞争。
- migrateLegacyWorkspacesToCentralDb() 仅在 central DB 初始化时执行；按 workspace 事务导入，写入 legacy_workspace_migrations 审计表，已完成源库幂等跳过，源 ads.db 不改名、不删除。
- 迁移使用真实 DDL 的列交集；业务主键沿用全局 UUID/文本 ID 约束，跨 workspace 冲突直接失败，不使用 INSERT OR IGNORE 静默丢数据。自增键由目标库重新分配，task_messages.plan_step_id 按导入映射修正。运行时对会话 upsert 也拒绝跨 workspace 冲突，避免无 workspace 条件的 ON CONFLICT 更新。
- 导入前验证 legacy schema_version、必需业务表和源列；版本不支持、缺表或出现目标 schema 未知列时在写入前失败，不做列交集式静默降级。

## 尚未启用的生产步骤

- 未自动删除或改名旧 workspace ads.db，未执行生产数据库迁移、服务重启或部署。
- 复合主键不是本次兼容迁移的前置条件：任务、会话、调度等业务 ID 由 UUID/文本全局生成并在迁移冲突时 fail-fast；workspace 条件负责读写隔离，附件 hash 与 schedule external_id 使用 workspace 复合唯一索引。若未来需要允许调用方在不同 workspace 复用同一业务 ID，再单独进行复合主键及外键重建。

## 验收

- tests/storage/workspacesDatabase.test.ts 覆盖同一 central DB 中两个 workspace 的任务、调度和附件隔离，以及 legacy 导入幂等和源文件不变。
- 迁移冲突、外键完整性和 FTS 重建应在生产切换前使用复制数据继续演练。
