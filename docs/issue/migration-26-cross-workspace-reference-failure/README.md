# Issue: Migration 26 工作区引用完整性迁移失败分析

## 1. 现象描述 (Symptom)

ADS 服务启动或前端发起 API 请求时，数据库初始化抛出迁移失败异常并导致服务不可用：

```
API: Migration 26 (Enforce workspace ownership across business table references) failed: conversation_messages.conversation_id contains cross-workspace or missing references
```

---

## 2. 根因分析 (Root Cause)

### 2.1 数据库合并与工作区隔离背景

近期 ADS 进行了多工作区存储整合，将各个独立工作区的数据集中到统一的中心数据库 workspaces.db（或共享状态库）：
* **Migration 24** 为所有业务表（tasks、task_plans、task_messages、conversations、conversation_messages、schedules 等）补充了 workspace_id 字段，以实现逻辑工作区隔离。
* **Migration 26**（Enforce workspace ownership across business table references）旨在建立触发器，禁止在插入或更新时出现跨工作区或缺失父级引用的脏数据。

### 2.2 Migration 26 的硬断言缺陷

在 server/storage/migrations.ts 中，Migration 26 在创建触发器之前，对 20 组外键引用关系进行了全量校验。

**缺陷所在**：
迁移脚本未对存量数据库中的历史孤儿数据或悬空引用进行任何自愈或前置清理，而是直接执行 throw new Error。只要存量数据库中存在任何无父级关联的子记录或历史跨工作区脏数据，数据库迁移就会永久阻塞、服务无法启动。

### 2.3 现场数据排查证据

对生产环境 ~/.local/state/ads/workspaces.db 的实际数据进行排查：
* schema_version 当前停留在 25，每次启动尝试升级至 26 时触发崩溃。
* 在 conversation_messages 表中存在 6 条孤儿子记录：
  - id=2,  conversation_id='chat-1', workspace_id='ads-fts-BaPj9K-37b1f17d71ef'
  - id=3,  conversation_id='chat-1', workspace_id='ads-fts-CJqtGc-54f0e9a6f91b'
  - id=4,  conversation_id='chat-1', workspace_id='ads-fts-FbasdR-89e685fd1373'
  - id=42, conversation_id='chat-1', workspace_id='ads-fts-cd1yLU-74203783910f'
  - id=43, conversation_id='chat-1', workspace_id='ads-fts-weDVcP-24f532667a05'
  - id=44, conversation_id='chat-1', workspace_id='ads-fts-8FO03V-95483d69f1d3'
* 上述记录来源于历史 FTS 测试或临时工作区调试，只写入了消息表而未在对应 workspace_id 下持久化 conversations 实体。当 Migration 26 执行匹配校验时，命中 count = 6 > 0，直接阻断了启动。

---

## 3. 改进方案比较 (Solutions & Tradeoffs)

### 方案 A：在 Migration 26 中引入自愈式前置数据修复（推荐）

* **思路**：
  在建立触发器之前，针对每组引用关系，根据子表外键列的 nullability 属性自动修复存量数据：
  1. **非空外键（NOT NULL）**：如 conversation_messages.conversation_id、task_plans.task_id、task_messages.task_id。子记录失去父实体在业务上已完全不可读/不可达，执行 DELETE FROM table WHERE ... 清理孤儿记录。
  2. **可空外键（nullable）**：如 tasks.parent_task_id、conversations.task_id、conversation_messages.task_id、attachments.task_id。执行 UPDATE table SET column = NULL WHERE ... 将悬空外键置空。
  3. 清理完成后，再执行触发器创建与校验。
* **优点**：
  - 保证迁移过程的自愈性与幂等性；
  - 无论开发机、测试机还是生产存量库，均可平滑升级，无需手动写脚本修复数据。
* **风险**：
  - 会物理删除原本就无法关联父实体的非空孤儿脏数据（符合关系数据库外键约束的一般清理规则）。

### 方案 B：仅手动在当前环境数据库中执行 SQL 删除脏记录

* **思路**：
  通过命令行直接 DELETE FROM conversation_messages WHERE ... 清理当前机器的 6 条记录，不改动 Migration 26 代码。
* **缺点**：
  - 治标不治本；迁移代码依然脆弱，任何其他环境（或未来导入旧数据）遇到类似孤儿子记录时均会再次崩溃。

---

## 4. 实施决策与代码范围

采用**方案 A**，修改 server/storage/migrations.ts 中 Migration 26 的实现：

1. **动态检查外键列约束**：
   使用 PRAGMA table_info(table) 读取目标列的 notnull 属性。
2. **前置修复**：
   - notnull === 1：执行 DELETE FROM table 清理孤儿行；
   - notnull === 0：执行 UPDATE table SET column = NULL 解除失效关联。
3. **创建约束触发器**：
   保留原有 enforce_table_column_insert 与 enforce_table_column_update 触发器，确保后续写操作严格受控。

---

## 5. 验证与回归保证

1. **迁移单元测试**：在 tests/storage/ 下新增包含孤儿非空记录与悬空可空引用的测试数据库，验证 Migration 26 能自愈修复并顺利升级至 v26。
2. **触发器有效性测试**：验证在升级完成后，跨工作区插入或修改仍然被触发器正确拒绝。
3. **生产库验证**：重新启动 ADS 实例，验证 workspaces.db 自动完成升级，Web 控制台与 Telegram Bot 恢复正常服务。

