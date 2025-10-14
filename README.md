# ADS

<div align="center">

**基于对话式 AI 和图谱化工作流的软件开发辅助工具**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![Vue 3](https://img.shields.io/badge/vue-3.x-brightgreen.svg)](https://vuejs.org/)
[![FastAPI](https://img.shields.io/badge/fastapi-0.118+-009688.svg)](https://fastapi.tiangolo.com/)

[功能特性](#功能特性) • [快速开始](#快速开始) • [核心概念](#核心概念) • [架构文档](./ARCHITECTURE.md) • [问题反馈](#问题反馈)

</div>

---

## 💡 解决的问题

在使用 AI 辅助软件开发时，你是否遇到过这些痛点？

### 1. **上下文丢失**
- ❌ 和 AI 聊了半天，换个对话窗口就忘了之前说的内容
- ✅ **ADS**: 将开发流程结构化为图谱节点，每个节点保持独立的对话上下文

### 2. **内容碎片化**
- ❌ 需求文档、设计方案、代码实现散落在不同的聊天记录里，难以整理
- ✅ **ADS**: 自动将 AI 生成的内容组织为文档节点，支持版本控制和一键导出

### 3. **流程不连贯**
- ❌ 写完需求要手动复制粘贴给 AI，让它生成设计方案；再复制设计方案生成代码...
- ✅ **ADS**: 定稿一个节点后，自动触发下游节点的 AI 生成，形成完整工作流

### 4. **质量难保证**
- ❌ AI 生成的内容质量参差不齐，需要反复修改
- ✅ **ADS**: 草稿机制 + 版本控制，支持多次修改和回滚，保留完整的编辑历史

### 5. **团队协作困难**
- ❌ 每个人和 AI 的对话是私有的，团队成员无法复用和审阅
- ✅ **ADS**: 图谱化展示，清晰的节点依赖关系，方便团队 Review 和知识沉淀

---

## 🎉 新功能（v0.2.0）

ADS 现在更加易用和灵活！借鉴了 [spec-kit](https://github.com/github/spec-kit) 的优秀设计：

### 🚀 一键初始化

```bash
ads init              # 在当前目录初始化
ads init --mode lite  # 使用轻量级模式
```

### 🔄 双模式架构

- **Lite 模式**: 纯文件操作，无需数据库，快速启动
- **Full 模式**: 完整功能，图谱可视化，版本历史

### ⚡ Slash Commands

在 `.ads/commands/` 中定义项目级自定义命令，支持变量替换：

```markdown
# 文件: .ads/commands/quick-bug.md

分析 bug: {{description}}
```

### 📋 灵活模板系统

- **节点模板**: 定义节点内容结构
- **工作流模板**: 一键创建完整工作流

详见 [新功能文档](./docs/NEW_FEATURES.md) 📖

---

## ✨ 功能特性

### 🎯 可视化工作流
- 将软件开发流程（需求 → 设计 → 实现 → 测试）表达为图谱节点
- 拖拽式操作，直观展示节点依赖关系
- 自动布局算法，支持复杂项目的结构化管理

### 💬 对话式编辑
- 每个节点内置 AI 对话窗口，支持多轮对话
- 流式响应，实时查看 AI 生成内容
- 一键将 AI 回复应用到草稿区

### 🤖 智能自动化
- 节点定稿后自动创建下游节点
- 基于上游内容自动生成 AI 提示词
- 支持配置化的工作流模板（DDD 标准流程、敏捷开发流程等）

### 📝 版本控制
- 每次定稿自动创建版本快照
- 支持版本对比和回滚
- 保留 AI 原始生成内容，追溯修改历史

### 💾 知识沉淀
- 聚合根节点自动保存为 Markdown 文件
- 支持导出完整项目文档
- 文档和图谱双重管理

---

## 🚀 快速开始

### 前置要求

- Python 3.10+
- Node.js 16+（仅 Web UI 需要）
- PDM（Python 包管理工具）

### 📦 包架构说明

ADS 现在分为三个独立的包：

1. **核心包 (`ads`)** - 必需
   - MCP 服务器（支持 Claude Code、Codex 等）
   - Slash Commands（项目级自定义命令）
   - 所有业务逻辑和数据库操作
   - 可独立使用，无需 Web UI

2. **服务器包 (`server/`)** - 可选
   - REST API 服务器（FastAPI）
   - 为 Web UI 提供 HTTP 接口
   - 轻量级包装层，依赖核心包

3. **Web UI (`web-ui/`)** - 可选
   - 可视化图谱界面
   - 拖拽式节点编辑
   - 依赖服务器包的 API

### 模式 1：仅使用核心包（推荐用于 AI CLI 集成）

```bash
# 1. 克隆项目
git clone https://github.com/yourusername/ads.git
cd ad

# 2. 安装核心包
pdm install

# 3. 初始化数据库
pdm run alembic upgrade head

# 4. 配置 MCP（参见 docs/HOW_TO_USE_WITH_CLAUDE_CODE.md）
# 或使用 Slash Commands（.claude/commands/）
```

**使用场景**：
- 在 Claude Code 中通过 MCP 调用工作流管理
- 使用 Slash Commands 快速创建工作流
- 无需图形界面的自动化脚本

### 模式 2：完整安装（Web UI + API + 核心）

```bash
# 1. 安装核心包
pdm install

# 2. 初始化数据库
pdm run alembic upgrade head

# 3. 安装并启动服务器
cd server
pdm install
pdm run dev  # 运行在 http://localhost:8000

# 4. 安装并启动前端（新终端）
cd ../web-ui
npm install
npm run dev  # 运行在 http://localhost:5173
```

**使用场景**：
- 可视化图谱管理
- 团队协作和 Review
- 拖拽式节点编辑

### 配置 API Key

创建 `.env` 文件：

```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1  # 可选
```

---

## 🧠 核心概念

### 节点（Node）
- 代表开发流程中的一个文档或工作单元
- 有明确的类型（聚合根、需求、设计、实现等）
- 包含两份内容：
  - `content`: 定稿内容（用于下游 AI 生成和文件导出）
  - `draft_content`: 草稿内容（用户编辑区）

### 边（Edge）
- 连接两个节点，表示依赖关系
- 定义了工作流的流转方向
- 遵循配置化的连接规则

### 工作流（Workflow）
- 一系列按顺序执行的节点
- 上游节点定稿后自动创建下游节点
- 支持模板化创建（一键生成完整流程）

### 草稿系统
- **草稿**：AI 生成或用户编辑的临时内容
- **定稿**：审阅通过的内容，创建版本快照并触发下游流转
- **版本**：每次定稿保存一个不可变的历史记录

---

## 📚 使用场景

### 场景 1：DDD 建模辅助

```
1. 创建 "聚合根" 节点 → 描述业务领域（如 "订单管理"）
2. 定稿后自动生成 "需求分析" → AI 分析业务需求
3. 定稿需求后自动生成 "设计方案" → AI 输出实体、值对象、领域服务设计
4. 定稿设计后自动生成 "实现代码" → AI 生成代码框架
```

### 场景 2：需求文档生成

```
1. 创建 "需求分析" 节点 → 输入需求关键点
2. 与 AI 对话完善需求细节
3. 定稿后自动导出为 Markdown 文档
```

### 场景 3：代码 Review 流程

```
1. 创建 "代码实现" 节点 → 粘贴待审阅代码
2. 与 AI 对话分析代码问题
3. AI 生成优化建议，保存为 "重构方案" 节点
```

---

## 🏗️ 技术架构

### 包架构（v0.3.0 重构）

```
ads/                    # 核心包（独立可用）
├── mcp/               # MCP 服务器（Claude Code 集成）
├── workspace/         # 工作流上下文管理
├── graph/             # 图谱数据模型和业务逻辑
├── storage/           # 数据库和持久化
└── config/            # 配置管理

server/                # 可选 REST API 包
├── pyproject.toml     # 独立依赖（依赖 ads>=0.1.0）
├── views/             # FastAPI 路由处理器
└── api/               # API 版本管理

web-ui/                # 可选 Web 界面
├── src/
└── package.json
```

### 核心包 (ads)

- **数据库**: SQLite + SQLAlchemy ORM
- **AI 集成**: OpenAI SDK（支持 Function Calling）
- **MCP 支持**: Model Context Protocol 集成
- **核心算法**: ReAct 模式（Reasoning + Acting）
- **无 FastAPI 依赖**: 可独立分发使用

### 服务器包 (server)

- **框架**: FastAPI（高性能异步 Web 框架）
- **轻量级设计**: 仅包含路由和异常转换
- **依赖核心包**: 所有业务逻辑来自 ads
- **独立部署**: 可单独安装和部署

### 前端 (web-ui)

- **框架**: Vue 3（Composition API）
- **图谱渲染**: Vue Flow（基于 React Flow）
- **UI 组件**: Element Plus
- **状态管理**: Pinia

### 关键设计

- **包分离**: 核心逻辑独立，可选组件模块化
- **草稿系统**: 分离草稿和定稿内容，支持安全编辑
- **自动流转**: 幂等性保证，不会重复创建节点
- **异步 AI 生成**: 后台线程执行，不阻塞 HTTP 响应
- **配置驱动**: 工作流规则外部化到 YAML 文件

详见 [ARCHITECTURE.md](./ARCHITECTURE.md) 和 [server/README.md](./server/README.md)

---

## 📖 文档

- **[新功能文档](./docs/NEW_FEATURES.md)** - v0.2.0 新功能详解（双模式、Slash Commands、模板系统）
- [架构文档](./ARCHITECTURE.md) - 完整的系统设计和技术细节
- **[服务器包文档](./server/README.md)** - 可选 REST API 服务器的安装和使用
- [API 文档](http://localhost:8000/docs) - FastAPI 自动生成的接口文档（需启动服务器）
- **[MCP 集成指南](./ads/mcp/README.md)** - 将 ADS 集成到 Claude Code、Codex CLI 等 AI 工具
- **[全局安装指南](./docs/HOW_TO_INSTALL_GLOBALLY.md)** - 如何让 ADS 在所有项目中可用
- [Claude Code 使用指南](./docs/HOW_TO_USE_WITH_CLAUDE_CODE.md) - 在 Claude Code 中使用
- [Codex CLI 使用指南](./docs/HOW_TO_USE_WITH_CODEX.md) - 在 Codex CLI 中使用

---

## 🛠️ 配置

### 工作流规则配置

编辑 `ads/config/workflow_rules.yaml` 可自定义：

- **节点类型**: 添加新的节点类型
- **连接规则**: 定义哪些节点可以相互连接
- **流转规则**: 配置自动流转的下游节点类型
- **AI 提示词**: 为每种流转配置专属的提示词模板

示例：

```yaml
node_types:
  custom_type:
    key: custom_type
    label: 自定义类型
    prefix: cst
    next_types: [downstream_type]
    color: "#67c23a"
    icon: "🆕"
```

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 开发流程

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

### 代码规范

- 后端：遵循 PEP 8 规范
- 前端：遵循 Vue 3 官方风格指南
- 提交信息：使用 Conventional Commits 格式

---

## 📝 许可证

本项目采用 [MIT 许可证](./LICENSE)

---

## 🙏 致谢

- [FastAPI](https://fastapi.tiangolo.com/) - 现代化的 Python Web 框架
- [Vue Flow](https://vueflow.dev/) - 强大的图谱渲染库
- [OpenAI](https://openai.com/) - 提供强大的 AI 能力
- [Element Plus](https://element-plus.org/) - 优秀的 Vue 3 UI 组件库

---

## 📧 联系方式

- **作者**: Andy963
- **Email**: Andy963@users.noreply.github.com
- **项目地址**: https://github.com/yourusername/ads

---

## ⭐ Star History

如果这个项目对你有帮助，欢迎 Star ⭐！

---

<div align="center">

Made with ❤️ by Andy963

</div>
