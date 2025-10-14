# ADS - AI-Driven Specification

**ADS** 是一个基于图谱的软件开发工作流管理系统，通过 Git 风格的命令和 AI 协作，帮助开发者管理需求、设计和实现的全流程。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)

## ✨ 核心特性

### 🌲 Git 风格的工作流管理
```bash
/ads.new feature "移动端支持"    # 创建新工作流
/ads.branch                       # 列出所有工作流
/ads.checkout <workflow>          # 切换工作流
/ads.status                       # 查看当前进度
/ads.commit <step>                # 定稿当前步骤
/ads.branch -d <workflow>         # 删除已完成的工作流
```

### 📊 图谱化的知识管理
- **节点系统**：需求、设计、实现、测试等节点类型
- **自动流转**：完成一个节点自动创建下一步
- **依赖追踪**：清晰的节点关系和依赖
- **版本历史**：每次定稿都保留完整历史

### 🤖 AI 深度协作
- **需求引导**：AI 通过提问帮你梳理需求
- **自动草稿**：基于上下文生成下一步草稿
- **智能修改**：AI 辅助修改和完善内容
- **MCP 协议**：支持 Claude Code 等 AI 工具

### 🔌 插件系统
- **工作流模板**：预定义的开发流程（如 FastAPI CRUD）
- **节点模板**：标准化的文档结构
- **参照示例**：最佳实践和代码示例
- **可扩展**：轻松创建自己的插件

---

## 🚀 快速开始

### 1. 安装

```bash
git clone https://github.com/yourusername/ad.git
cd ad
pdm install
```

### 2. 在项目中初始化

```bash
cd /path/to/your/project
ads init
```

这会创建 `.ads/` 目录：
```
your-project/
├── .ads/
│   ├── config.json      # 配置文件
│   ├── ads.db          # 图谱数据库
│   ├── rules.md        # 项目规则
│   └── templates/      # 自定义模板
├── docs/
│   └── specs/          # 工作流文档
└── src/                # 你的代码
```

### 3. 配置 AI 工具

#### Claude Code

编辑 `~/.claude/config.json`：
```json
{
  "mcpServers": {
    "ads": {
      "command": "pdm",
      "args": ["run", "python", "-m", "ads.mcp.server"],
      "cwd": "/path/to/ad",
      "description": "ADS - AI-Driven Specification"
    }
  }
}
```

#### Codex（实验性）

编辑 `~/.codex/config.toml`：
```toml
[mcp_servers.ads]
command = "pdm"
args = ["run", "python", "-m", "ads.mcp.server"]
cwd = "/path/to/ad"
type = "stdio"
```

---

## 📖 使用场景

### 场景 1：快速功能开发

```
你：/ads.new feature "移动端支持"

AI：已创建工作流。现在需要收集详细需求。
    1. 功能描述：这个功能具体要做什么？
    2. 核心需求：最核心的需求是什么？
    ...

你：需要支持 iOS 和 Android，实现响应式设计...

AI：(整理成结构化文档) 请确认这个需求描述是否准确？

你：确认

AI：使用 ads.update 更新节点...已更新为 draft

你：/ads.commit requirement

AI：已定稿需求节点，自动创建 design 节点...
```

### 场景 2：Bug 修复流程

```
你：/ads.new bugfix "登录重复提交"

AI：已创建 Bug 修复工作流。
    1. 问题描述：这个 bug 具体是什么？
    2. 复现步骤：如何一步步复现？
    ...

你：用户快速点击登录按钮会发送多次请求...

AI：(生成 bug report) → 你确认 → AI 生成分析草稿 → ...
```

### 场景 3：使用插件加速开发

```
你：/ads.new feature "User CRUD API"

AI：检测到这是 CRUD 功能，找到 FastAPI 插件。
    根据插件模板，我会引导你完成：
    1. API 设计（端点、参数、响应）
    2. 数据模型（Pydantic 模型）
    3. 路由实现（参考 User CRUD 示例）
    ...
```

---

## 🏗️ 架构设计

### 核心模块

```
ads/
├── graph/              # 图谱引擎
│   ├── models.py      # Node, Edge 数据模型
│   ├── crud.py        # 图谱 CRUD 操作
│   ├── auto_workflow.py  # 自动流转引擎
│   └── file_manager.py   # 文件同步
│
├── workspace/          # 工作空间
│   ├── detector.py    # 工作空间检测
│   └── context.py     # 工作流上下文（类似 git branch）
│
├── plugins/            # 插件系统
│   ├── interface.py   # 插件接口
│   ├── loader.py      # 插件加载器
│   └── registry.py    # 插件注册表
│
├── mcp/               # MCP Server（AI 集成）
│   ├── server.py      # MCP 主服务器
│   └── tools/         # MCP 工具集
│       ├── workflow.py   # 工作流管理
│       ├── context.py    # 上下文管理
│       └── graph.py      # 图谱操作
│
└── storage/           # 数据持久化
    ├── database.py    # SQLite 数据库
    └── models.py      # SQLAlchemy 模型
```

### 工作流状态机

```
┌─────────────┐
│ 创建工作流   │ /ads.new
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Draft 状态  │ 编辑、AI 生成
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Finalize  │ /ads.commit
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  自动流转    │ 创建下一步节点
└─────────────┘
```

---

## 🔌 插件开发

### 创建插件

```python
# my-plugin/plugin.py
from ads.plugins import Plugin, PluginMetadata

class MyPlugin(Plugin):
    def get_metadata(self):
        return PluginMetadata(
            name="my-plugin",
            version="1.0.0",
            description="My custom plugin",
            scenes=["my_scene"],
            node_types=["my_node"]
        )
    
    def get_workflow_templates(self):
        # 返回工作流定义（YAML）
        pass
    
    def get_node_templates(self, node_type):
        # 返回节点模板（Markdown）
        pass
    
    def get_references(self, scene):
        # 返回参照示例
        pass
```

### 使用插件

```python
from ads.plugins import get_plugin_loader

loader = get_plugin_loader()
loader.load_plugin_from_path("path/to/my-plugin", "my-plugin")
```

---

## 🛠️ 开发

### 运行测试

```bash
pdm run pytest                    # 所有测试
pdm run pytest tests/test_graph.py  # 特定测试
pdm run pytest --cov=ads          # 覆盖率
```

### 代码质量

```bash
pdm run black ads tests     # 格式化
pdm run mypy ads           # 类型检查
pdm run ruff ads           # Lint
```

---

## 📝 文档

- [插件系统设计](docs/PLUGIN_SYSTEM_DESIGN.md)
- [测试总结](docs/TEST_SUMMARY.md)
- [Slash Commands](docs/slash_commands/)
  - [ads.new](docs/slash_commands/ads.new.md)
  - [ads.branch](docs/slash_commands/ads.branch.md)
  - [ads.status](docs/slash_commands/ads.status.md)
  - [ads.commit](docs/slash_commands/ads.commit.md)

---

## 🗺️ Roadmap

- [x] 图谱化工作流管理
- [x] Git 风格命令系统
- [x] 自动流转引擎
- [x] 插件系统
- [x] MCP Server（Claude Code 支持）
- [ ] Web UI 可视化
- [ ] 更多插件（Django、Spring Boot、React 等）
- [ ] 团队协作功能
- [ ] Git 集成（自动关联 commit）

---

## 🤝 贡献

欢迎贡献！

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交改动 (`git commit -m 'Add AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 提交 Pull Request

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE)

---

## 🙏 致谢

- [Model Context Protocol](https://modelcontextprotocol.io/) - AI 集成标准
- [Anthropic](https://www.anthropic.com/) - Claude 和 MCP SDK

---

<div align="center">

Made with ❤️ 

</div>
