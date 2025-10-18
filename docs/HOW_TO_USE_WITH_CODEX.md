# 如何在 Codex CLI 中使用 ADS

本指南说明如何在日常开发中通过 Codex CLI (OpenAI) 配合 ADS 完成任务。

> **使用 Claude？** 请查看 [Claude Code 使用指南](./HOW_TO_USE_WITH_CLAUDE_CODE.md)

## 前置配置

### 1. 配置 MCP Server

在 `~/.codex/config.toml` 添加：

```toml
[mcpServers.ad]
command = "pdm"
args = ["run", "python", "-m", "ads.mcp.server"]
description = "ADS - AI-Driven Specification"
```

或使用命令：

```bash
cd /path/to/ad-project
codex mcp add ad
```

### 2. 验证配置

启动 Codex CLI：

```bash
codex
```

在 Codex 中询问：

```
列出可用的 MCP 工具
```

应该能看到 `ad` 的 14 个工具。

---

## 使用场景

### 场景 1：发现 Bug，创建修复工作流

**你的任务**: 发现登录接口有 bug，需要修复

**在 Codex 中输入**:

```
我发现登录接口在高并发时偶尔返回 500 错误，帮我创建一个 bugfix 工作流
```

**Codex 会自动**:
1. 调用 `read_merged_rules()` 读取项目规则
2. 调用 `get_workflow_template("bugfix")` 获取 bugfix 模板
3. 调用 `create_node()` 创建 bug_report 节点
4. 调用 `create_node()` 创建 bug_analysis 节点
5. 调用 `create_edge()` 建立节点关系

**你会得到**:
```
✓ 已创建 bugfix 工作流
  - bug_report_xxx: 登录接口在高并发时偶尔返回 500 错误
  - bug_analysis_xxx: 等待分析

提示：请在 Web UI (http://localhost:5173) 中查看工作流图谱
```

---

### 场景 2：执行分析任务

**你的任务**: 已经创建了 bug_analysis 节点，需要 AI 帮忙分析

**在 Codex 中输入**:

```
帮我分析 bug_analysis_xxx 这个节点的任务
```

**Codex 会自动**:
1. 调用 `get_node_context("bug_analysis_xxx")` 获取完整上下文
   - 包含父节点（bug_report）的内容
2. 调用 `read_merged_rules()` 读取规则约束
3. 分析代码，生成分析报告
4. 调用 `update_node()` 更新节点内容

**分析过程**:
```
📋 正在读取任务上下文...
  - 父节点: bug_report_xxx (登录接口 500 错误)

📖 正在读取项目规则...
  - 架构规则: 使用 DDD 分层架构
  - 代码规则: 使用 context manager 管理资源

🔍 正在分析代码...
  (Codex 会读取相关代码文件)

💡 分析结果:
  问题定位：auth/services.py:45 数据库连接未释放
  根本原因：异常路径缺少 context manager
  修复建议：使用 with get_db() as db

✓ 已更新 bug_analysis_xxx 节点
```

---

### 场景 3：实现修复方案

**你的任务**: 分析完成，需要编写代码修复

**在 Codex 中输入**:

```
根据 bug_analysis_xxx 的分析，帮我实现修复方案
```

**Codex 会自动**:
1. 调用 `get_node_context("bug_analysis_xxx")` 读取分析结果
2. 调用 `read_merged_rules()` 确保符合规范
3. 修改 `auth/services.py` 文件
4. 调用 `create_node()` 创建 bug_fix 节点记录修复内容
5. 调用 `finalize_node()` 标记节点为已完成

**修复过程**:
```
📖 正在读取分析结果...
  - 问题文件: auth/services.py:45
  - 修复方案: 使用 context manager

✏️ 正在修改代码...
  修改文件: auth/services.py
  - 将 db = get_db() 改为 with get_db() as db
  - 调整缩进

✅ 代码已修改

📝 正在记录修复内容...
  - 创建 bug_fix_xxx 节点
  - 记录修改前后对比

✓ 修复完成！请在 Web UI 查看完整工作流
```

---

### 场景 4：添加新功能

**你的任务**: 需要添加一个用户导出功能

**在 Codex 中输入**:

```
我需要添加一个用户数据导出功能，帮我创建 DDD 标准工作流
```

**Codex 会自动**:
1. 调用 `get_workflow_template("ddd_standard")` 获取 DDD 模板
2. 调用 `read_merged_rules()` 读取 DDD 架构规范
3. 创建完整工作流：
   - requirement 节点（需求）
   - design 节点（设计）
   - implementation 节点（实现）
   - test 节点（测试）

**创建结果**:
```
✓ 已创建 DDD 标准工作流：用户数据导出功能

节点列表：
  1. requirement_xxx: 用户数据导出需求
  2. design_xxx: 导出功能领域设计（待完成）
  3. implementation_xxx: 实现代码（待完成）
  4. test_xxx: 测试用例（待完成）

💡 下一步：
  请在 requirement 节点中详细描述需求，然后让我帮你完成设计
```

---

### 场景 5：继续执行设计任务

**你的任务**: 需求已经写好，需要 AI 帮忙设计

**在 Codex 中输入**:

```
帮我完成 design_xxx 节点的设计任务
```

**Codex 会自动**:
1. 调用 `get_node_context("design_xxx")` 获取需求内容
2. 调用 `read_merged_rules()` 读取 DDD 规范
3. 调用 `get_node_type_config("design")` 获取设计模板
4. 生成领域设计文档
5. 调用 `update_node()` 更新设计内容

**设计过程**:
```
📖 正在读取需求...
  - 用户数据导出功能
  - 支持 CSV、JSON 格式
  - 需要权限控制

📐 正在进行领域设计...

根据 DDD 规范，设计如下：

聚合根：User
领域服务：UserExportService
值对象：ExportFormat (CSV, JSON)
仓储接口：IUserRepository
应用服务：UserExportApplicationService

✓ 设计完成，已更新 design_xxx 节点

💡 下一步：
  设计已完成，是否继续实现代码？
```

---

### 场景 6：查询工作空间状态

**你的任务**: 想知道当前有哪些待完成任务

**在 Codex 中输入**:

```
当前工作空间有哪些待完成的任务？
```

**Codex 会自动**:
1. 调用 `get_workspace_info()` 获取概览
2. 调用 `list_nodes(status="draft")` 列出草稿节点

**输出结果**:
```
📊 当前工作空间状态：

统计：
  - 总节点数: 12
  - 草稿节点: 5
  - 已定稿节点: 7
  - 总关系: 8

待完成任务（草稿节点）：
  1. [design] 用户导出功能设计 (design_xxx)
  2. [implementation] 登录功能实现 (implementation_yyy)
  3. [test] 用户模块测试 (test_zzz)
  4. [bug_fix] 修复缓存问题 (bug_fix_aaa)
  5. [bug_verify] 验证登录修复 (bug_verify_bbb)

💡 提示：
  使用命令查看详情: 帮我完成 design_xxx 节点
```

---

## 常用命令模板

### 创建工作流

```bash
# 创建 bugfix 工作流
"发现一个 [描述问题]，创建 bugfix 工作流"

# 创建功能开发工作流
"需要开发 [功能描述]，创建 DDD 工作流"

# 创建快速功能
"需要快速实现 [功能]，创建 quick_feature 工作流"
```

### 执行任务

```bash
# 让 AI 执行某个节点
"帮我完成 [node_id] 节点"
"分析 [node_id] 并给出建议"
"实现 [node_id] 的代码"

# 带上下文执行
"根据 [parent_node_id] 的内容，完成 [node_id]"
```

### 查询状态

```bash
# 查看工作空间
"当前有哪些任务？"
"列出所有草稿节点"
"显示工作空间统计"

# 查看节点详情
"显示 [node_id] 的详细信息"
"查看 [node_id] 的上下文"
```

### 修改状态

```bash
# 标记完成
"将 [node_id] 标记为已完成"

# 更新内容
"更新 [node_id] 的内容为: [新内容]"
```

---

## 工作流类型

### 1. Bugfix 工作流

**适用场景**: 发现并修复 Bug

**节点流程**:
```
bug_report (Bug 报告)
    ↓
bug_analysis (原因分析)
    ↓
bug_fix (修复实现)
    ↓
bug_verify (验证测试)
```

**触发命令**:
```
"发现 [问题描述]，创建 bugfix 工作流"
```

### 2. DDD 标准工作流

**适用场景**: 新功能开发（遵循 DDD）

**节点流程**:
```
requirement (需求分析)
    ↓
design (领域设计)
    ↓
implementation (代码实现)
    ↓
test (测试验证)
```

**触发命令**:
```
"需要开发 [功能]，创建 DDD 工作流"
```

### 3. Quick Feature 工作流

**适用场景**: 快速功能实现（无需完整设计）

**节点流程**:
```
requirement (需求)
    ↓
implementation (实现)
```

**触发命令**:
```
"快速实现 [功能]"
```

---

## 最佳实践

### 1. 明确任务描述

❌ **不好**:
```
"修复 bug"
```

✅ **好**:
```
"登录接口在高并发时返回 500 错误，创建 bugfix 工作流"
```

### 2. 引用节点 ID

❌ **不好**:
```
"帮我完成设计"
```

✅ **好**:
```
"帮我完成 design_a1b2c3d4 节点"
```

### 3. 提供上下文

❌ **不好**:
```
"写代码"
```

✅ **好**:
```
"根据 design_xxx 的设计，实现 implementation_yyy 节点的代码"
```

### 4. 分步执行

对于复杂任务，分步让 AI 完成：

```
第一步: "创建用户导出功能的 DDD 工作流"
第二步: "完成 requirement_xxx 的需求分析"
第三步: "完成 design_xxx 的领域设计"
第四步: "完成 implementation_xxx 的代码实现"
```

---

## 典型工作流程

### 完整示例：修复一个 Bug

```bash
# 1. 发现问题，创建工作流
codex> 发现登录接口在高并发时返回 500 错误，创建 bugfix 工作流

# Codex 创建了工作流，返回节点 ID

# 2. 让 AI 分析问题
codex> 帮我分析 bug_analysis_abc123 节点

# Codex 读取代码，生成分析报告

# 3. 实现修复
codex> 根据分析结果，实现 bug_fix_def456 节点的修复

# Codex 修改代码，记录修复内容

# 4. 验证修复
codex> 帮我写 bug_verify_ghi789 节点的测试用例

# Codex 生成测试代码

# 5. 标记完成
codex> 将 bug_verify_ghi789 标记为已完成

# 6. 查看结果
codex> 显示当前工作空间状态
```

---

## 注意事项

### 1. Web UI 配合使用

- MCP 工具负责**创建和更新**节点
- Web UI 负责**可视化展示**工作流图谱
- 建议同时打开：
  - 终端：运行 Codex CLI
  - 浏览器：http://localhost:5173 查看图谱

### 2. 节点 ID 的获取

**方式 1**: Codex 创建后会返回
```
✓ 已创建节点: bug_report_abc123
```

**方式 2**: 询问 Codex
```
codex> 列出所有节点
```

**方式 3**: Web UI 中查看

### 3. 规则自动生效

Codex 在执行任务时会自动：
- 读取 `docs/rules/merged.md` 规则
- 遵循规则约束
- 无需手动指定

### 4. 工作空间隔离

- 每个工作空间的节点和规则是隔离的
- 确保在正确的工作空间目录下运行 Codex

---

## 故障排查

### Codex 无法找到 MCP Server

**问题**: Codex 提示找不到 ad

**解决**:
```bash
# 1. 检查配置文件
cat ~/.codex/config.toml

# 2. 重新配置
cd /path/to/ad-project
codex mcp add ad

# 3. 重启 Codex
```

### MCP Server 启动失败

**问题**: Codex 提示连接失败

**解决**:
```bash
# 1. 手动测试 MCP Server
cd /path/to/ad-project
pdm run python -m ads.mcp.server

# 2. 检查依赖
pdm install

# 3. 检查数据库
pdm run python -c "from ads.storage.database import init_db; init_db()"
```

### 工作空间未初始化

**问题**: Codex 提示 "工作空间未初始化"

**解决**:
```bash
# 在 Web UI 中创建工作空间
# 或者使用 API 创建
curl -X POST http://localhost:8000/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "path": "/path/to/project"}'
```

---

## 高级用法

### 1. 批量操作

```
"创建 3 个 bug_verify 节点，分别验证登录、注册、修改密码功能"
```

### 2. 复杂查询

```
"列出所有 bug_fix 类型的已完成节点"
"找出所有待实现的 implementation 节点"
```

### 3. 自定义工作流

```
"创建一个工作流：需求 -> 设计 -> 前端实现 -> 后端实现 -> 测试"
```

---

## 总结

通过 Codex CLI + ADS MCP Server，你可以：

1. ✅ **自然语言交互**：用人话描述任务
2. ✅ **自动遵循规则**：AI 自动读取并遵循项目规范
3. ✅ **结构化管理**：所有任务以图谱方式组织
4. ✅ **上下文感知**：AI 知道任务的前因后果
5. ✅ **实时更新**：Web UI 实时显示工作流进度

**核心理念**：你用自然语言描述任务，Codex 通过 MCP 调用 ADS 的工具，自动创建、执行、更新工作流。

现在开始使用吧！🚀
