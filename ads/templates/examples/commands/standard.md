# Standard - 标准开发流程

启动完整标准开发流程

## 变量

- `{{project_name}}` - 项目/模块名称
- `{{project_description}}` - 项目描述

## 提示词

开发项目/模块：

**项目**: {{project_name}}
**描述**: {{project_description}}

请按以下步骤执行：

1. **定义聚合根** (aggregate 节点)
   - 领域概念和边界
   - 核心实体和值对象
   - 业务规则和约束

2. **需求分析** (requirement 节点)
   - 功能需求列表
   - 非功能需求
   - 用户故事
   - 验收标准

3. **架构设计** (design 节点)
   - 系统架构
   - 数据模型
   - API 设计
   - 技术选型

4. **代码实现** (implementation 节点)
   - 核心逻辑实现
   - 单元测试
   - 代码规范

5. **测试验证** (test 节点)
   - 集成测试
   - 功能测试
   - 性能测试
   - 测试报告

遵循项目规则：`.ads/rules/workspace.md`
