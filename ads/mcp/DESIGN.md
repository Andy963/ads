# AD Assistant MCP Server 设计文档

## 概述

将 AD Assistant 系统暴露为 MCP Server，让 Claude Code 等 AI 工具可以：
- 读取项目规则和工作流模板
- 查询和操作知识图谱节点
- 遵循规则执行开发任务

## MCP Tools 设计

### 1. Rules 相关工具

#### `read_merged_rules`
- **描述**: 读取合并后的规则（全局 + 工作空间）
- **参数**:
  - `workspace_path` (string, optional): 工作空间路径，默认当前目录
- **返回**: Markdown 格式的完整规则内容
- **用途**: AI 在执行任务前读取约束规则

#### `list_rules`
- **描述**: 列出所有规则（支持筛选）
- **参数**:
  - `workspace_path` (string, optional): 工作空间路径
  - `category` (string, optional): 分类筛选
  - `enabled` (boolean, optional): 启用状态筛选
- **返回**: 规则列表（JSON）
- **用途**: 让 AI 了解可用规则

### 2. Workflow 相关工具

#### `list_workflow_templates`
- **描述**: 列出所有工作流模板
- **参数**: 无
- **返回**: 模板列表（包含 id, name, description）
- **用途**: 让 AI 知道可用的标准流程

#### `get_workflow_template`
- **描述**: 获取工作流模板详情
- **参数**:
  - `template_id` (string, required): 模板 ID（如 "bugfix", "standard", "feature"）
- **返回**: 完整模板定义（包含节点类型、步骤、连接规则）
- **用途**: AI 根据模板创建工作流

#### `get_node_type_config`
- **描述**: 获取节点类型配置
- **参数**:
  - `node_type` (string, required): 节点类型（如 "bug_report", "design"）
- **返回**: 节点类型配置（颜色、图标、描述、模板）
- **用途**: AI 了解节点类型规范

### 3. Graph 相关工具（读取）

#### `get_workspace_info`
- **描述**: 获取工作空间基本信息
- **参数**:
  - `workspace_path` (string, optional): 工作空间路径
- **返回**: 工作空间配置、节点统计
- **用途**: AI 了解当前工作空间状态

#### `list_nodes`
- **描述**: 列出节点
- **参数**:
  - `workspace_path` (string, optional): 工作空间路径
  - `node_type` (string, optional): 节点类型筛选
  - `status` (string, optional): 状态筛选（draft/finalized）
  - `limit` (int, optional): 限制数量
- **返回**: 节点列表（id, title, type, status）
- **用途**: AI 查询现有节点

#### `get_node`
- **描述**: 获取节点详情
- **参数**:
  - `node_id` (string, required): 节点 ID
- **返回**: 完整节点信息（包含内容、父节点、子节点）
- **用途**: AI 读取节点上下文

#### `get_node_context`
- **描述**: 获取节点完整上下文（包含父节点链）
- **参数**:
  - `node_id` (string, required): 节点 ID
- **返回**: 节点 + 所有父节点的内容
- **用途**: AI 了解任务的完整背景

### 4. Graph 相关工具（写入）

#### `create_node`
- **描述**: 创建新节点
- **参数**:
  - `workspace_path` (string, required): 工作空间路径
  - `node_type` (string, required): 节点类型
  - `title` (string, required): 节点标题
  - `content` (string, required): 节点内容（Markdown）
  - `parent_id` (string, optional): 父节点 ID
  - `status` (string, optional): 状态（draft/finalized），默认 draft
- **返回**: 创建的节点信息
- **用途**: AI 创建工作流节点

#### `update_node`
- **描述**: 更新节点内容
- **参数**:
  - `node_id` (string, required): 节点 ID
  - `content` (string, optional): 新内容
  - `status` (string, optional): 新状态
- **返回**: 更新后的节点信息
- **用途**: AI 更新任务进度

#### `create_edge`
- **描述**: 创建节点关系
- **参数**:
  - `source_id` (string, required): 源节点 ID
  - `target_id` (string, required): 目标节点 ID
  - `edge_type` (string, required): 关系类型（hierarchy/dependency）
- **返回**: 创建的边信息
- **用途**: AI 建立节点依赖关系

#### `finalize_node`
- **描述**: 标记节点为已定稿
- **参数**:
  - `node_id` (string, required): 节点 ID
- **返回**: 更新后的节点信息
- **用途**: AI 完成任务后标记

### 5. 辅助工具

#### `get_system_info`
- **描述**: 获取系统信息
- **参数**: 无
- **返回**: 版本、可用工具列表、配置信息
- **用途**: AI 了解系统能力

## 使用场景

### 场景 1: 外部 AI 发现 Bug 并创建修复流程

```python
# 1. AI 分析代码发现问题
# 2. 读取规则
rules = read_merged_rules(workspace_path=".")

# 3. 获取 bugfix 模板
template = get_workflow_template(template_id="bugfix")

# 4. 创建 bug_report 节点
bug_node = create_node(
    workspace_path=".",
    node_type="bug_report",
    title="登录接口返回 500 错误",
    content="# Bug 描述\n...",
    status="draft"
)

# 5. 创建 bug_analysis 节点
analysis_node = create_node(
    workspace_path=".",
    node_type="bug_analysis",
    title="分析登录错误原因",
    content="# 分析\n...",
    parent_id=bug_node.id
)

# 6. 创建关系
create_edge(
    source_id=bug_node.id,
    target_id=analysis_node.id,
    edge_type="hierarchy"
)

# 7. 用户在前端看到实时更新的图谱
```

### 场景 2: 用户设计工作流，AI 执行

```python
# 1. 用户在 Web UI 创建工作流（已有节点）
# 2. AI 读取第一个待执行节点
node = get_node(node_id="design_001")

# 3. 读取上下文（父节点）
context = get_node_context(node_id="design_001")

# 4. 读取规则
rules = read_merged_rules()

# 5. AI 执行任务，生成内容

# 6. 更新节点
update_node(
    node_id="design_001",
    content="# 设计方案\n...",
    status="finalized"
)
```

## 技术实现

### 依赖
- `mcp` - MCP Python SDK
- 现有的 services 层（RuleService, WorkflowConfig, NodeService）

### 文件结构
```
ads/mcp/
├── __init__.py
├── server.py          # MCP Server 主程序
├── tools/
│   ├── __init__.py
│   ├── rules.py       # Rules 相关工具
│   ├── workflow.py    # Workflow 相关工具
│   ├── graph.py       # Graph 相关工具
│   └── system.py      # 系统工具
└── DESIGN.md          # 本文档
```

### 配置文件
`mcp.json` - Claude Code 配置
```json
{
  "mcpServers": {
    "ad-assistant": {
      "command": "python",
      "args": ["-m", "ads.mcp.server"],
      "cwd": "/path/to/project"
    }
  }
}
```

## 测试

使用 MCP Inspector 测试：
```bash
# 启动 inspector
npx @modelcontextprotocol/inspector python -m ads.mcp.server
```

## 优势

1. **标准化**: 遵循 MCP 协议，任何支持 MCP 的 AI 工具都能使用
2. **解耦**: AI 工具不需要了解我们的内部实现
3. **可发现**: AI 自动发现所有可用工具
4. **类型安全**: MCP 提供参数验证
5. **易扩展**: 添加新工具只需定义新函数

## 后续扩展

- 支持 Resources（暴露规则、模板作为资源）
- 支持 Prompts（预定义常用提示词）
- 添加权限控制
- 添加操作日志
