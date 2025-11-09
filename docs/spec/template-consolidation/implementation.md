# Template Consolidation Implementation

## 1. 任务分解
1. **模板文件整理**
   - 将 `templates/nodes/*.md`、`templates/workflows/unified.yaml` 内容迁移为 6 个顶层文件：
     - `templates/instructions.md`
     - `templates/rules.md`
     - `templates/requirement.md`
     - `templates/design.md`
     - `templates/implementation.md`
     - `templates/workflow.yaml`
   - 删除旧子目录，更新 Git 追踪列表。

2. **构建脚本更新**
   - 修改 `scripts/copy-templates.js`：若发现子目录则报错，否则复制所有文件到 `dist/templates`.

3. **工作区初始化与同步**
   - `workspace/service.ts`：
     - `initWorkspace` 直接复制 `templates/*` → `.ads/templates/*`。
     - `syncWorkspaceTemplates` 检测旧结构、执行备份与覆盖。
   - 新增 `copyTemplateFiles`、`cleanupLegacyTemplates` 辅助函数，复用复制逻辑。

4. **模板消费者重构**
   - 全局替换路径，确保仅引用扁平文件。
   - 更新 `workflow/templateService.ts`、`graph/service.ts` 等模块的读取路径。

5. **文档与日志**
   - README / Telegram 文档新增模板说明。
   - CLI 日志（如 `syncWorkspaceTemplates`）输出新结构提示。

6. **测试与验证**
   - 手动：删除 `.ads`，重新初始化，确保模板与源一致。
   - 自动/脚本：模拟旧结构存在的同步场景，断言 `.ads/templates` 被正确重置。

## 2. 实施顺序
1. 调整 `templates/` 目录，确认内容与旧模板一致。
2. 更新 `scripts/copy-templates.js` 并手动运行验证 `dist/templates` 输出。
3. 修改 `workspace/service.ts` 等核心逻辑，先通过 `npm run build && npm start` 验证 `.ads` 初始化。
4. 搜索并替换旧路径引用，逐个模块测试（workflow creation、ads CLI）。
5. 更新文档与日志。
6. 最终回归测试：
   - `npm run build`
   - `rm -rf .ads && npm start`
   - `npm test`（若存在相关单测）。

## 3. 交付与验收
- 交付内容：代码更改、模板文件、文档更新、手动验证记录。
- 验收条件：满足 requirements 文档中的五项验收标准，并附带测试/手动验证说明。
