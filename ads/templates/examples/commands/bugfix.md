# Bugfix - Bug 修复流程

启动 Bug 修复工作流

## 变量

- `{{bug_description}}` - Bug 描述
- `{{severity}}` - 严重程度（高/中/低）

## 提示词

修复以下 Bug：

**Bug**: {{bug_description}}
**严重程度**: {{severity}}

请按以下步骤执行：

1. **创建 Bug Report** (bug_report 节点)
   - 详细描述问题现象
   - 记录复现步骤
   - 说明预期 vs 实际行为

2. **分析根本原因** (bug_analysis 节点)
   - 定位问题代码
   - 分析产生原因
   - 评估影响范围

3. **实施修复** (bug_fix 节点)
   - 提出修复方案
   - 实现代码修改
   - 确保不引入新问题

4. **验证修复** (bug_verify 节点)
   - 编写测试用例
   - 验证 Bug 已修复
   - 回归测试

遵循项目规则：`.ads/rules/workspace.md`
