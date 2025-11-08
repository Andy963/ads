# Template Consolidation Requirements

## 背景
- 代码仓库目前维护两套模板：`templates/`（开发期同步 `.ads/templates`）与 `ads/templates/`（仅用于 `initWorkspace` 自举）。
- `ads/templates/` 已残缺，仅剩 `rules.md`，而 `.ads/templates` 依旧期望 `nodes/`、`workflows/` 子目录，导致初始化与同步逻辑复杂且容易出现不一致。
- 需要统一模板来源，避免双份模板产生漂移，同时简化目录结构，方便用户理解与修改。

## 目标
1. **唯一模板源**：仅保留 `templates/` 目录，所有运行时/初始化逻辑都从这一份读取。
2. **扁平结构**：目录内只包含 5 个顶层文件（建议：`rules.md`、`requirement.md`、`design.md`、`implementation.md`、`workflow.yaml`），不再区分 `nodes/`、`workflows/` 子目录。
3. **统一复制**：`initWorkspace` 创建 `.ads` 时只复制该目录内容；`syncWorkspaceTemplates` 亦以它为源。
4. **构建一致**：`scripts/copy-templates.js` 直接把 `templates/*` 复制到 `dist/templates`，供发行版本使用。
5. **清理遗留引用**：移除所有对 `ads/templates` 以及子目录结构 (`nodes/`, `workflows/`) 的依赖，包含文档与日志描述。

## 范围
- 涉及目录：`templates/`、`.ads/templates/`、`dist/templates/`、`ads/templates/`（删除或停用）。
- 涉及模块：`workspace/service.ts`（初始化、同步）、`scripts/copy-templates.js`、`workflow/templateService.ts`、`graph/service.ts` 以及其他读取模板的模块。
- 文档更新：README 以及任何描述模板结构的文档（例如 Telegram 文档）需同步说明“单目录 + 5 文件”的新结构。

## 详细需求
### 文件结构
- `templates/` 下仅存 5 个文件，对应：
  - `rules.md`：全局规则模板。
  - `requirement.md`：需求文档模板。
  - `design.md`：设计文档模板。
  - `implementation.md`：实施/验证模板。
  - `workflow.yaml`：统一工作流定义（原 `workflows/unified.yaml` 的内容）。
- 删除 `templates/nodes/` 与 `templates/workflows/` 目录；若仍需历史内容，需在迁移时合并进上述 4 个 Markdown + 1 个 YAML。

### 初始化逻辑
- `initWorkspace` 不再读取 `ads/templates/`，改为直接复制 `templates/` 至 `.ads/templates/`：
  - 若 `templates/` 缺失，需抛出错误并提示用户执行 `git checkout templates` 或从版本包恢复。
  - 初始化前若检测到 `.ads/templates` 采用旧结构（存在 `nodes/` 子目录），需先清空或备份再写入。

### 同步逻辑
- `syncWorkspaceTemplates`：
  - 对比 `templates/*` 和 `.ads/templates/*`（逐文件哈希或时间戳），不同则覆盖。
  - 若发现旧结构残留（例如 `.ads/templates/nodes`），打印一次性提示并清理。
  - 更新日志文案，说明模板已切换为“单目录”。避免提及 `nodes/workflows`。

### 构建脚本
- `scripts/copy-templates.js` 需改成“复制模板目录下所有文件（不含子目录）到 `dist/templates`”。
- CLI/脚本运行时统一引用 `dist/templates` 的新结构，确保发布包（npm）仍能自举。

### 运行时代码
- 全局搜索并替换旧路径引用，包括但不限于：
  - `templates/nodes`, `templates/workflows`, `.ads/templates/nodes`, `.ads/templates/workflows`.
  - `ads/templates` 目录 (如仍存在)。
  - 确保读取 YAML/Markdown 的 API 适配扁平文件名（例如 workflow 模型指向 `workflow.yaml`）。

### 文档与提示
- README、Telegram 指南等文档需描述新的模板结构及如何自定义。
- CLI 如打印模板列表或提示（`syncWorkspaceTemplates` 日志等）需同步更新。

### 迁移/兼容
- 运行 `syncWorkspaceTemplates` 时若发现旧结构，则：
  1. 提示用户模板结构将被重置。
  2. 清空 `.ads/templates/*`（或迁移关键文件）后写入新文件。
- 若外部用户修改了旧模板，需要提供迁移指引（例如在 README 中描述“请将旧 `nodes/*.md` 合并到 new `*.md`”）。

## 不在范围
- 不包含对文档模板内容本身的改写（除非为合并所需的结构调整）。
- 不涉及 ADS 工作流逻辑或数据库结构的改动。

## 验收标准
1. **初始化成功**：删除 `.ads/` 后执行 `npm run build && npm start`，新的 `.ads/templates` 只含 5 个文件，且内容与 `templates/` 一致。
2. **同步覆盖**：手动修改 `.ads/templates/rules.md` 后重启 CLI，文件被自动还原为 `templates/rules.md`。
3. **构建产物**：`dist/templates` 仅包含同样的 5 个文件，且发布包可在无源码的情况下完成初始化。
4. **代码引用**：代码库中不再存在 `templates/nodes`、`templates/workflows`、`ads/templates` 的引用。
5. **文档一致**：README（及相关指南）描述新的模板结构，没有旧目录命名。

## 风险与缓解
- **遗留工作区兼容**：同步时删除旧模板可能覆盖用户定制内容 → 在清理前提示备份，并考虑保留旧文件的 `.bak`。
- **workflow 定义**：拆除 `workflows/` 目录后，所有依赖 YAML 的逻辑必须正确指向新文件 → 需要完善测试。
- **文档更新遗漏**：需要全局搜索“nodes”、“workflows”字样，避免文档仍指导用户编辑旧目录。

## 下一步
1. 确认新模板文件命名与现有工作流代码的字段映射。
2. 整理/迁移旧模板内容至 5 个文件。
3. 实施上述代码与脚本改动，并编写回归测试或手动验收脚本。
4. 更新文档并通知团队模板结构调整。
