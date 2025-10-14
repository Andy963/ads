# ADS 核心架构文档

**版本**: 1.0  
**定位**: MCP Server + 工作流引擎 + Slash Commands

---

## 1. 核心定位

ADS 是一个**轻量级的开发工作流管理工具**，通过 MCP 协议与 Claude 集成：

- **MCP Server**: 暴露工具给 Claude
- **工作流引擎**: 管理开发流程（bugfix/feature/standard）
- **Slash Commands**: 用户自定义任务指令
- **Git 友好**: 所有内容保存为 Markdown

---

## 2. 目录结构

```
ads/                          (~7000行代码)
│
├── mcp/                      # MCP Server (2779行)
│   ├── server.py             # MCP 主入口
│   └── tools/                # 7个 MCP 工具
│       ├── workflow.py       # 工作流管理
│       ├── context.py        # 工作流上下文
│       ├── graph.py          # 图谱操作
│       ├── commands.py       # Slash Commands
│       ├── templates.py      # 模板管理
│       ├── workspace.py      # 工作空间检测
│       └── system.py         # 系统信息
│
├── graph/                    # 工作流引擎 (2145行)
│   ├── models.py             # Node, Edge, NodeVersion
│   ├── crud.py               # CRUD 操作
│   ├── config.yaml           # 工作流配置
│   ├── auto_workflow.py      # 自动工作流引擎
│   ├── finalize_helper.py    # 定稿辅助
│   └── file_manager.py       # 文件管理
│
├── workspace/                # 工作空间管理 (633行)
│   ├── detector.py           # 检测工作空间路径
│   └── context.py            # 工作流上下文（类似 git branch）
│
├── commands/                 # Slash Commands (218行)
│   ├── loader.py             # 加载 .ads/commands/*.md
│   └── executor.py           # 变量替换
│
├── templates/                # 模板系统 (284行)
│   ├── loader.py             # 加载模板
│   ├── renderer.py           # 渲染模板
│   └── examples/             # 官方示例
│       ├── commands/         # bugfix.md, feature.md, standard.md
│       ├── nodes/            # 9个节点模板
│       └── workflows/        # bugfix.yaml, feature.yaml, standard.yaml
│
├── storage/                  # 数据库 (571行)
│   ├── database.py           # SQLite
│   └── migrations/           # 7个迁移（Node/Edge/NodeVersion）
│
└── cli/                      # CLI (329行)
    └── init.py               # ads init（初始化工作空间）
```

---

## 3. MCP 工具列表

ADS 暴露 **7 类工具**给 Claude：

### 3.1 工作流管理 (workflow.py)

| 工具 | 功能 |
|------|------|
| `list_workflow_templates` | 列出可用模板（bugfix/feature/standard）|
| `get_workflow_template` | 获取模板详情 |
| `create_workflow` | 创建工作流 |

### 3.2 工作流上下文 (context.py)

| 工具 | 功能 |
|------|------|
| `get_active_workflow` | 获取当前活动工作流 |
| `get_workflow_status` | 获取工作流状态 |
| `switch_workflow` | 切换工作流 |
| `list_workflows` | 列出所有工作流 |
| `get_step_node` | 通过步骤名获取节点 |
| `update_step_draft` | 更新节点草稿 |
| `finalize_step` | 定稿节点（触发自动流转）|

### 3.3 图谱操作 (graph.py)

| 工具 | 功能 |
|------|------|
| `create_node` | 创建节点 |
| `update_node` | 更新节点 |
| `get_node` | 获取节点详情 |
| `list_nodes` | 列出节点 |
| `finalize_node` | 定稿节点 |

### 3.4 Slash Commands (commands.py)

| 工具 | 功能 |
|------|------|
| `list_commands` | 列出可用命令 |
| `get_command` | 获取命令详情 |
| `execute_command` | 执行命令（变量替换）|

### 3.5 模板管理 (templates.py)

| 工具 | 功能 |
|------|------|
| `list_node_templates` | 列出节点模板 |
| `get_node_template` | 获取节点模板 |
| `list_workflow_templates_files` | 列出工作流模板文件 |

### 3.6 工作空间 (workspace.py)

| 工具 | 功能 |
|------|------|
| `detect_workspace` | 检测工作空间路径 |

### 3.7 系统信息 (system.py)

| 工具 | 功能 |
|------|------|
| `get_system_info` | 获取系统信息 |

---

## 4. 核心概念

### 4.1 工作流 (Workflow)

**3 种工作流模板：**

1. **bugfix** - Bug 修复流程
   ```
   bug_report → bug_analysis → bug_fix → bug_verify
   ```

2. **feature** - 功能开发
   ```
   requirement → implementation
   ```

3. **standard** - 标准开发流程
   ```
   aggregate → requirement → design → implementation → test
   ```

**工作流是什么？**
- 类似 Git 分支概念
- 一个工作流包含多个节点（Node）
- 节点之间通过边（Edge）连接
- 同一时间只能有一个活动工作流

### 4.2 节点 (Node)

**节点类型（9种）：**

| 类型 | 用途 | 工作流 |
|------|------|--------|
| `bug_report` | Bug 报告 | bugfix |
| `bug_analysis` | 问题分析 | bugfix |
| `bug_fix` | 修复方案 | bugfix |
| `bug_verify` | 验证方案 | bugfix |
| `requirement` | 需求 | feature, standard |
| `implementation` | 实现 | feature, standard |
| `aggregate` | 聚合根 | standard |
| `design` | 设计 | standard |
| `test` | 测试 | standard |

**节点状态：**
- `draft`: 草稿（可编辑）
- `finalized`: 已定稿（触发自动流转）

**节点内容：**
- 保存在数据库（Node 表）
- 同时保存为 Markdown 文件（`docs/specs/{workflow_id}/{node_type}.md`）

### 4.3 工作流上下文 (Context)

**类似 Git 的工作机制：**

```bash
# Git 风格
git branch                  # 查看分支
git checkout feature-123    # 切换分支

# ADS 风格
/ads.branch                 # 查看工作流
/ads.switch feature-123     # 切换工作流
```

**步骤名称：**

用户无需记住 node_id，使用步骤名称：

```python
# bugfix 工作流
get_step_node("report")     # → bug_report 节点
get_step_node("analysis")   # → bug_analysis 节点
get_step_node("fix")        # → bug_fix 节点
get_step_node("verify")     # → bug_verify 节点

# standard 工作流
get_step_node("requirement")     # → requirement 节点
get_step_node("design")          # → design 节点
get_step_node("implementation")  # → implementation 节点
```

### 4.4 Slash Commands

**用户自定义任务指令：**

放在 `.ads/commands/` 目录：

```
.ads/
  commands/
    bugfix.md       # 启动 Bug 修复流程
    feature.md      # 启动功能开发流程
    my-task.md      # 用户自定义任务
```

**命令格式（Markdown）：**

```markdown
# My Task

任务描述

## 变量

- `{{param1}}` - 参数1
- `{{param2}}` - 参数2

## 提示词

执行以下任务：

参数1: {{param1}}
参数2: {{param2}}

步骤：
1. ...
2. ...
```

**执行命令：**

```python
execute_command("my-task", {"param1": "value1", "param2": "value2"})
# → 返回替换变量后的提示词
```

---

## 5. 工作流引擎

### 5.1 自动流转机制

**触发时机：** 当节点定稿（finalize）时

**流转规则：** 在 `graph/config.yaml` 中定义

```yaml
node_types:
  requirement:
    next_types:
      - design
```

**流转逻辑：**

```
finalize_node(requirement_node)
  ↓
自动创建 design 节点
  ↓
AI 自动生成 design 内容（基于 requirement）
```

### 5.2 文件管理

**所有节点保存为 Markdown：**

```
docs/specs/
  workflow_abc123/           # 工作流目录
    metadata.json            # 工作流元数据
    requirement.md           # 需求节点
    design.md                # 设计节点
    implementation.md        # 实现节点
```

**好处：**
- Git 友好（diff、merge、版本控制）
- 可直接编辑
- AI 可读取

---

## 6. 使用流程

### 6.1 初始化

```bash
cd my-project
ads init
```

生成结构：
```
my-project/
  .ads/
    ads.db              # SQLite 数据库
    context.json        # 工作流上下文
    commands/           # 用户自定义命令
    templates/          # 用户自定义模板
  docs/
    specs/              # 工作流节点（Markdown）
```

### 6.2 配置 MCP

**Claude Desktop 配置：**

```json
{
  "mcpServers": {
    "ads": {
      "command": "python",
      "args": ["-m", "ads.mcp.server"],
      "cwd": "/path/to/ads"
    }
  }
}
```

### 6.3 使用工作流

**在 Claude 中：**

```
1. 创建工作流
   /ads.create bugfix "修复登录 Bug"

2. 查看当前工作流
   /ads.branch

3. 编辑节点
   update_step_draft("report", "Bug 描述...")

4. 定稿（触发自动流转）
   finalize_step("report")
   → 自动创建 analysis 节点

5. 切换工作流
   /ads.switch feature-456
```

### 6.4 使用 Slash Commands

```
1. 列出可用命令
   list_commands()

2. 执行命令
   execute_command("bugfix", {
     "bug_description": "登录失败",
     "severity": "高"
   })
   → 返回完整的任务提示词
   → Claude 根据提示词创建工作流
```

---

## 7. 数据流

```
用户 → Claude → MCP Tools → Workspace Context
                              ↓
                         Graph Engine
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
              数据库 (SQLite)      文件系统 (Markdown)
              - Node 表            - docs/specs/
              - Edge 表            - .ads/commands/
              - NodeVersion 表     - .ads/templates/
```

---

## 8. 技术栈

| 组件 | 技术 |
|------|------|
| MCP 协议 | mcp-python |
| 数据库 | SQLite + Alembic |
| ORM | SQLAlchemy |
| CLI | Python argparse |
| 配置 | YAML |
| 模板 | Jinja2 |

---

## 9. 关键特性

### 9.1 轻量级
- 无需 Web UI
- 无需 Server 进程
- 纯本地文件存储

### 9.2 Git 友好
- 所有内容 Markdown
- 可 diff/merge
- 版本控制

### 9.3 灵活扩展
- 用户自定义 Slash Commands
- 用户自定义节点模板
- 用户自定义工作流模板

### 9.4 AI 原生
- 通过 MCP 与 Claude 深度集成
- 自动流转 + AI 生成
- 基于上下文的智能提示

---

## 10. 对比

| 特性 | ADS | 传统项目管理工具 |
|------|-----|------------------|
| 界面 | Claude (MCP) | Web UI |
| 存储 | Markdown + SQLite | 云端数据库 |
| 协作 | Git | 平台内协作 |
| 扩展 | Slash Commands | 插件市场 |
| AI | 原生集成 | 后期集成 |
| 部署 | 本地运行 | SaaS / 自部署 |

---

## 11. 下一步优化方向

### 优先级 P0（核心功能）
- ✅ 工作流引擎完善
- ✅ Slash Commands 系统
- ✅ MCP 工具完整

### 优先级 P1（体验优化）
- 🔲 补充测试用例
- 🔲 优化错误处理
- 🔲 完善文档

### 优先级 P2（扩展功能）
- 🔲 多人协作（Git 分支）
- 🔲 工作流可视化（Mermaid）
- 🔲 更多工作流模板

---

## 12. 总结

**ADS 核心架构：**

```
┌─────────────────────────────────────┐
│           Claude (用户界面)          │
└──────────────┬──────────────────────┘
               │ MCP 协议
               ↓
┌─────────────────────────────────────┐
│        MCP Server (7个工具)          │
├─────────────────────────────────────┤
│  • 工作流管理                        │
│  • 工作流上下文                      │
│  • 图谱操作                          │
│  • Slash Commands                   │
│  • 模板管理                          │
│  • 工作空间                          │
│  • 系统信息                          │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│       工作流引擎 (Graph)             │
├─────────────────────────────────────┤
│  • 节点管理 (Node/Edge)             │
│  • 自动流转                          │
│  • AI 内容生成                       │
│  • 版本控制                          │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│          存储层                      │
├─────────────────────────────────────┤
│  • SQLite (结构化数据)              │
│  • Markdown (内容文件)              │
│  • YAML (配置)                      │
└─────────────────────────────────────┘
```

**核心价值：**
- 轻量级，无依赖
- Git 友好，易协作
- AI 原生，深度集成
- 灵活扩展，用户自定义

**适用场景：**
- 个人/小团队开发
- 需要 AI 辅助的开发流程
- 偏好 Git 工作流
- 追求轻量级工具
