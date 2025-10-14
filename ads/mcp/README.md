# AD Assistant MCP Server

将 AD Assistant 暴露为 MCP (Model Context Protocol) Server，让 Claude Code、Codex CLI 等 AI 工具可以直接调用我们的功能。

## 架构概览

```
AI 工具（Codex/Claude Code）
    ↓ MCP 协议
AD Assistant MCP Server
    ↓ 调用
AD Assistant Services
    ↓ 操作
数据库/文件系统
```

## 功能特性

### 1. Rules 工具
- `read_merged_rules`: 读取合并后的规则（全局 + 工作空间）
- `list_rules`: 列出所有规则（支持筛选）

### 2. Workflow 工具
- `list_workflow_templates`: 列出所有工作流模板
- `get_workflow_template`: 获取模板详情
- `get_node_type_config`: 获取节点类型配置

### 3. Graph 读取工具
- `get_workspace_info`: 获取工作空间信息
- `list_nodes`: 列出节点（支持筛选）
- `get_node`: 获取节点详情
- `get_node_context`: 获取节点完整上下文（含父节点链）

### 4. Graph 写入工具
- `create_node`: 创建新节点
- `update_node`: 更新节点内容/状态
- `create_edge`: 创建节点关系
- `finalize_node`: 标记节点为已定稿

### 5. System 工具
- `get_system_info`: 获取系统信息和能力

## 快速开始

### 1. 启动 MCP Server（测试用）

```bash
# 使用 MCP Inspector 测试
npx @modelcontextprotocol/inspector python -m ads.mcp.server
```

这将启动一个 Web 界面，让你可以：
- 查看所有可用工具
- 测试工具调用
- 查看请求/响应

### 2. 配置 Claude Code

#### 方式 A：项目级配置（推荐）

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "ad": {
      "command": "python",
      "args": ["-m", "ads.mcp.server"]
    }
  }
}
```

#### 方式 B：用户级配置

在 `~/.claude.json` 中配置：

```json
{
  "projects": {
    "/path/to/your/project": {
      "mcpServers": {
        "ad": {
          "command": "python",
          "args": ["-m", "ads.mcp.server"]
        }
      }
    }
  }
}
```

### 3. 配置 Codex CLI

在 `~/.codex/config.toml` 中添加：

```toml
[mcpServers.ad]
command = "python"
args = ["-m", "ads.mcp.server"]
description = "AD Assistant MCP Server"
```

或使用 Codex CLI 命令：

```bash
codex mcp add ad
```

## 使用示例

### 场景 1：AI 发现 Bug 并创建修复流程

在 Claude Code 或 Codex CLI 中：

```
我发现了一个登录接口的 bug，帮我创建一个 bugfix 工作流
```

AI 会自动：
1. 调用 `read_merged_rules()` 读取项目规则
2. 调用 `get_workflow_template("bugfix")` 获取 bugfix 模板
3. 调用 `create_node()` 创建 bug_report 节点
4. 调用 `create_node()` 创建 bug_analysis 节点
5. 调用 `create_edge()` 建立节点关系
6. 用户在前端看到实时更新的图谱

### 场景 2：AI 执行设计任务

在 Claude Code 中：

```
帮我完成 design_001 节点的设计任务
```

AI 会自动：
1. 调用 `get_node("design_001")` 读取任务要求
2. 调用 `get_node_context("design_001")` 读取父节点上下文
3. 调用 `read_merged_rules()` 读取约束规则
4. 生成设计文档
5. 调用 `update_node("design_001", content=..., status="finalized")` 更新节点
6. 用户在前端看到已完成的设计节点

### 场景 3：AI 查询工作空间状态

```
当前工作空间有哪些待完成的任务？
```

AI 会自动：
1. 调用 `get_workspace_info()` 获取概览
2. 调用 `list_nodes(status="draft")` 列出草稿节点
3. 汇总并展示给用户

## 工具详细说明

### read_merged_rules

读取合并后的规则文件（`.rules/merged.md`）。

**参数**:
- `workspace_path` (可选): 工作空间路径，默认当前目录

**返回**: Markdown 格式的规则内容

**示例**:
```json
{
  "name": "read_merged_rules",
  "arguments": {
    "workspace_path": "."
  }
}
```

### get_workflow_template

获取工作流模板的完整定义。

**参数**:
- `template_id` (必需): 模板 ID（bugfix/standard/feature）

**返回**: JSON 格式的模板定义

**示例**:
```json
{
  "name": "get_workflow_template",
  "arguments": {
    "template_id": "bugfix"
  }
}
```

### create_node

创建新的图谱节点。

**参数**:
- `workspace_path` (必需): 工作空间路径
- `node_type` (必需): 节点类型（bug_report/design/implementation 等）
- `title` (必需): 节点标题
- `content` (必需): 节点内容（Markdown）
- `parent_id` (可选): 父节点 ID
- `status` (可选): draft/finalized，默认 draft

**返回**: 创建的节点信息

**示例**:
```json
{
  "name": "create_node",
  "arguments": {
    "workspace_path": ".",
    "node_type": "bug_report",
    "title": "登录接口返回 500 错误",
    "content": "# Bug 描述\n\n用户登录时偶尔返回 500 错误...",
    "status": "draft"
  }
}
```

### get_node_context

获取节点的完整上下文，包括所有父节点的内容链。

**参数**:
- `node_id` (必需): 节点 ID

**返回**: 节点 + 父节点链的完整内容

**示例**:
```json
{
  "name": "get_node_context",
  "arguments": {
    "node_id": "design_001"
  }
}
```

返回格式：
```json
{
  "context_text": "# 任务上下文\n\n## 父节点链\n\n### 1. 需求分析 (requirement)\n...",
  "node": { ... },
  "parents": [ ... ]
}
```

## 开发指南

### 添加新工具

1. 在对应的 `tools/` 模块中实现函数：

```python
# tools/your_module.py

async def your_new_tool(param1: str, param2: Optional[int] = None) -> str:
    """
    工具描述。
    """
    try:
        # 实现逻辑
        result = {"data": "..."}
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)
```

2. 在 `server.py` 的 `list_tools()` 中注册：

```python
Tool(
    name="your_new_tool",
    description="工具描述",
    inputSchema={
        "type": "object",
        "properties": {
            "param1": {
                "type": "string",
                "description": "参数 1 说明"
            },
            "param2": {
                "type": "integer",
                "description": "参数 2 说明"
            }
        },
        "required": ["param1"]
    }
)
```

3. 在 `call_tool()` 中添加调用逻辑：

```python
elif name == "your_new_tool":
    result = await your_module.your_new_tool(
        param1=arguments["param1"],
        param2=arguments.get("param2")
    )
    return [TextContent(type="text", text=result)]
```

### 测试工具

```bash
# 启动 Inspector
npx @modelcontextprotocol/inspector python -m ads.mcp.server

# 在浏览器中测试工具调用
```

## 故障排查

### MCP Server 无法启动

1. 检查 Python 版本：`python --version`（需要 3.10+）
2. 检查依赖安装：`pdm install`
3. 检查 MCP SDK：`pip list | grep mcp`

### AI 工具无法发现 MCP Server

1. 检查配置文件路径是否正确
2. 检查配置文件格式是否正确（JSON/TOML）
3. 重启 AI 工具

### 工具调用失败

1. 检查数据库连接
2. 检查工作空间是否初始化
3. 查看 MCP Server 日志（stderr 输出）

## 架构决策

### 为什么选择 MCP？

1. **标准化**: MCP 是 Anthropic 推出的开放标准，未来会有更多工具支持
2. **解耦**: AI 工具不需要了解我们的内部实现细节
3. **可发现**: AI 自动发现所有可用工具，无需手动配置每个功能
4. **类型安全**: MCP 提供参数验证和类型检查
5. **易扩展**: 添加新功能只需定义新函数

### 为什么使用 stdio？

MCP 支持多种传输方式（stdio、HTTP、SSE），我们选择 stdio 因为：
1. **简单**: 不需要启动独立的 HTTP 服务器
2. **安全**: 不暴露网络端口
3. **高效**: 进程间通信，延迟低
4. **标准**: 所有 MCP 客户端都支持 stdio

## 参考资料

- [MCP 官方文档](https://modelcontextprotocol.io/)
- [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)
- [Claude Code MCP 指南](https://docs.claude.com/en/docs/claude-code/mcp)
- [Codex CLI MCP 文档](https://developers.openai.com/codex/mcp)

## 许可证

MIT
