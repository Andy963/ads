# ADS 单一工作流实施计划

> 本计划依据 `templates/implementation_template.md` 编写，用于落实统一工作流的代码与文档改造。

## 准备事项
- [ ] 对照 `docs/specs/requirement.md`、`docs/specs/design.md` 确认需求、设计范围明确。
- [ ] 列出受影响文件：`src/graph/config.yaml`、`src/workflow/templateService.ts`、`src/workflow/service.ts`、`docs/specs` 目录结构、`templates` 三个模板。
- [ ] 确定验证方式：单元测试（graph/workflow）、生成流程手工演练、文档检查。

## 阶段一：Step 1 需求与意图
- [ ] T1-1：收集并归档需求与设计确认
  - 负责人：流程整合小组
  - 交付物：`docs/specs/{timestamp}-{slug}/requirement.md` 初稿（由模板生成）
  - 步骤：
    1. 使用 `/ads.new` 创建示例工作流，确认目录与文件生成逻辑。
    2. 依据需求模板补充试点项目的背景、目标、范围、干系人、依赖。
  - 验证清单：
    - [ ] 需求文档包含全部必填字段
    - [ ] 无旧模板字段残留
- [ ] T1-2：更新行为规则映射
  - 负责人：规则维护人
  - 步骤：同步需求中的行为规则至设计、实施阶段引用
  - 验证清单：
    - [ ] 需求、设计、实施文档规则段落一致

## 阶段二：Step 2 方案与计划
- [ ] T2-1：更新配置与模板映射
  - 负责人：Graph 子系统负责人
  - 步骤：
    1. 在 `src/graph/config.yaml` 保留单一工作流模板，定义三个节点顺序（需求/设计/实施）。
    2. 确认节点类型（requirement/design/implementation）描述与颜色等属性。
  - 验证清单：
    - [ ] `workflow_templates` 仅包含 unified 模板
    - [ ] 节点顺序与设计文档一致
- [ ] T2-2：调整模板服务逻辑
  - 负责人：Workflow 服务负责人
  - 步骤：
    1. 更新 `templateService.listWorkflowTemplates()` 返回唯一模板描述。
    2. 更新 `createWorkflowFromTemplate`，移除标准/feature/bugfix 映射，默认使用 unified。
    3. 确保 `getAllWorkflowTemplates` 缓存刷新或重启后正确读取。
  - 验证清单：
    - [ ] CLI `/ads.new` 调用无需模板参数也能成功创建工作流
    - [ ] 错误信息仅提示统一模板
- [ ] T2-3：文档占位与命名规则实现
  - 负责人：Workspace 模块维护者
  - 步骤：
    1. 在 `src/workflow/service.ts` 或相关生成逻辑中，调用 `getWorkspaceSpecsDir` 创建 `docs/specs/{timestamp}-{slug}/`。
    2. 写入 `requirement.md`、`design.md`、`implementation.md` 三个文件，内容来自 `templates/*.md`。
    3. 确保不会覆盖已有目录，并生成友好的 slug（例如 `{date}-{sanitized-title}`）。
  - 验证清单：
    - [ ] 多次运行 `/ads.new` 生成不同子目录
    - [ ] 文件内容匹配模板占位

## 阶段三：Step 3 实施与收尾
- [ ] T3-1：移除旧模板与别名
  - 涉及文件：`templates/examples/workflows`、`config.yaml` 旧节点、CLI 帮助文案
  - 步骤：删除 standard/feature/bugfix 模板，更新文档与提示
  - 验证清单：
    - [ ] 仓库内不再包含旧模板文件
    - [ ] CLI 帮助中不再提及旧模板
- [ ] T3-2：测试与验证
  - 负责人：测试负责人
  - 命令 / 测试：
    - `npm run test workflow`（示例）
    - 手工执行 `/ads.new`、`/ads.add requirement ...`、`/ads.commit requirement`
  - 验证清单：
    - [ ] 单元及集成测试通过
    - [ ] 手工演练得到三份文档并可按步骤推进
- [ ]* T3-3：回滚与复盘（可选）
  - 触发条件：统一模板上线后 2 周内出现重大阻塞
  - 步骤：
    1. 还原 `config.yaml` 与旧模板备份
    2. 发布复盘报告并制定改进计划
  - 验证清单：
    - [ ] 回滚脚本执行成功
    - [ ] 复盘记录在 `docs/retro/` 存档

## 状态追踪
- 记录方式：使用现有 workflow 数据库与 `/ads.status`
- 更新频率：至少每周在例会上同步
- 风险与阻塞：集中记录于 `docs/specs/risk-log.md`

## 变更记录
- 2025-10-25：创建实施计划草案（责任人：流程整合小组）
