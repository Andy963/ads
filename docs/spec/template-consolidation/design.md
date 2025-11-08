# Template Consolidation Design

## 1. 架构概览
- **模板来源统一**：`templates/` 继续作为源码层的模板目录；CLI 与构建脚本都从这里读取，再同步到 `.ads/templates` 或 `dist/templates`。
- **扁平结构**：`templates/` 下仅保留 5 个文件，表示规则、需求、设计、实施、工作流。所有读取模板的模块通过文件名匹配，避免路径硬编码。
- **同步策略**：
  - 启动 CLI 时 `syncWorkspaceTemplates` 比较 `templates/*` 与 `.ads/templates/*`；若存在旧结构（如 `nodes/`）则清理后整体复制。
  - 构建脚本 `scripts/copy-templates.js` 简化为“复制整个目录的扁平文件”。
- **运行期引用**：所有消费模板的代码（workflow service、graph service 等）通过新的路径常量读取 `.ads/templates/<file>`。

## 2. 关键模块设计
### 2.1 模板目录常量
- 新增 `TEMPLATE_FILES = ['rules.md','requirement.md','design.md','implementation.md','workflow.yaml']`，位于 `workspace/service.ts` 或单独 util。
- 提供工具函数 `ensureTemplates(): string[]` 返回模板源目录，集中管理路径。

### 2.2 初始化流程
- `initWorkspace`：
  1. 检查 `templates/` 是否存在 5 个文件。
  2. 使用 `fs.cp`（或自定义 copy 函数）将目录复制到 `.ads/templates/`。如 `.ads/templates` 存在旧结构，先递归删除。
  3. 将 workflow YAML 注册到数据库（若现有逻辑依赖 `workflows/unified.yaml`，改指向新文件）。

### 2.3 同步流程
- `syncWorkspaceTemplates`：
  - 对 `.ads/templates` 进行快速扫描：若发现子目录或非预期文件，打印警告并清空目录（备份策略：可将旧目录重命名为 `templates_legacy_<timestamp>`）。
  - 遍历 `templates/*`，逐文件比对内容哈希；差异文件覆盖写入。
  - 同步后返回概述（文件数量、是否覆盖）。

### 2.4 构建脚本
- `scripts/copy-templates.js`：
  - 读取 `templates` 目录下的全部文件（不进入子目录），按原名复制到 `dist/templates`。
  - 若检测到子目录，则在构建时抛错提醒开发者。

### 2.5 模板消费者
- **Workflow 模块**：原引用 `workflows/unified.yaml` 的代码改为 `workflow.yaml`。
- **Graph/Spec 模块**：原引用 `nodes/*.md` 的逻辑改为根据文件名（例如 `requirement.md`）加载。
- 提供单一 `loadTemplate(name: string)` helper，内部拼出 `.ads/templates/<name>` 并做存在性检查。

### 2.6 文档更新
- README 及其他指南新增“模板结构”章节，展示 5 个文件及作用。
- 机器人/CLI 日志在同步模板时打印新的路径信息，避免用户寻找不存在的 `nodes/` 目录。

## 3. 数据迁移策略
- 在 `syncWorkspaceTemplates` 中：
  - 若发现 `.ads/templates/nodes` 或 `.ads/templates/workflows`，将其内容搬到 `_legacy` 备份目录并提示用户。
  - 之后写入新文件，确保实际使用的只有 5 个文件。

## 4. 风险与缓解
| 风险 | 缓解措施 |
| --- | --- |
| 用户自定义旧模板被覆盖 | 同步前备份旧目录并打印路径提示 |
| 代码遗漏旧路径引用 | 通过 `rg 'templates/(nodes|workflows)'` 全局搜查，添加回归测试 |
| workflow YAML 解析调整 | 在单元测试中验证 `createWorkflowFromTemplate` 仍能读取 `workflow.yaml` |

## 5. 验证策略
- 手动测试：删除 `.ads/`，执行 `npm run build && npm start`，确认 `.ads/templates` 生成 5 个文件。
- 自动测试：新增脚本或单测模拟 `syncWorkspaceTemplates`，在存在旧目录时验证备份 + 覆盖逻辑。
