# Ads Slash Commands 使用指南

## 概述

Ads 系统现在支持通过 **Slash Commands** 在 AI CLI 工具（Claude Code、Codex、Gemini CLI 等）中完成完整的工作流，无需依赖 Web UI。

这意味着你可以：
- ✅ 直接在 AI 对话中创建工作流
- ✅ 编辑节点内容
- ✅ 定稿节点并自动触发下游流程
- ✅ 查询工作流状态
- ✅ 获取完整上下文进行代码实现

**工作流程图：**

```
用户在 AI CLI 中输入
    ↓
/ads.new "用户认证"
    ↓
MCP Server 创建工作流节点
    ↓
/ads.edit agg_123 (编辑内容)
    ↓
/ads.finalize agg_123 (定稿)
    ↓
自动创建下游节点 (requirement, design, implementation)
    ↓
/ads.edit req_456 → /ads.finalize req_456 (继续流转)
    ↓
文档自动保存到 docs/specs/
    ↓
/ads.context impl_789 (获取完整上下文)
    ↓
根据上下文实现代码
```

---

## 1. 安装和设置

### 1.1 初始化项目并集成 AI 工具

```bash
# 选择你使用的 AI 工具

# Claude Code
ads init --ai claude

# Codex CLI
ads init --ai codex

# Gemini CLI
ads init --ai gemini

# GitHub Copilot
ads init --ai copilot
```

这会：
- 创建 `.ads/` 工作空间
- 初始化数据库
- 在 `.claude/commands/` (或 `.codex/commands/` 等)生成 slash command 文件
- 配置 MCP server

### 1.2 启动 MCP Server

在项目根目录：

```bash
# 方式 1: 使用 pdm
pdm run python -m ads.mcp.server

# 方式 2: 使用 python
python -m ads.mcp.server
```

保持 MCP Server 运行（在后台或单独的终端窗口）。

### 1.3 启动 AI 工具

```bash
# Claude Code
claude

# Codex
codex

# Gemini CLI
gemini
```

---

## 2. 可用的 Slash Commands

| 命令 | 说明 | 示例 |
|------|------|------|
| `/ads.new` | 创建新工作流 | `/ads.new` |
| `/ads.edit <node_id>` | 编辑节点内容 | `/ads.edit agg_123` |
| `/ads.finalize <node_id>` | 定稿节点并触发流转 | `/ads.finalize req_456` |
| `/ads.query` | 查询工作流状态 | `/ads.query` |
| `/ads.context <node_id>` | 获取节点完整上下文 | `/ads.context design_789` |

---

## 3. 完整工作流示例

### 3.1 创建新的 DDD 工作流

```
User: /ads.new

AI: 我会帮你创建一个新工作流。你需要什么类型的工作流？
- ddd_standard: 完整 DDD 开发流程
- bugfix: Bug 修复流程
- quick_feature: 快速功能开发

User: ddd_standard

AI: 很好！这个功能是关于什么的？（例如："用户认证"、"订单管理"）

User: 用户认证

AI: 正在创建 DDD 标准工作流 "用户认证"...

[AI 调用 MCP 工具 create_workflow_from_template...]
[AI 调用 MCP 工具 get_node...]

✅ 工作流创建成功！

Root Node: agg_a1b2c3d4 "用户认证"
Type: aggregate (聚合根)
Status: Draft (未定稿)

📍 位置:
- Web UI: http://localhost:5173/graph
- 文件: docs/specs/用户认证_a1b2c3d4/

🎯 下一步:
1. 编辑根节点: /ads.edit agg_a1b2c3d4
2. 在 Web UI 查看: http://localhost:5173
3. 查询状态: /ads.query

现在要开始编辑聚合根内容吗？我可以帮你定义：
- 领域边界
- 核心实体和值对象
- 业务规则
```

### 3.2 编辑聚合根内容

```
User: 是的，开始编辑

AI: 好的！让我们定义用户认证聚合根。请告诉我：

1. 这个聚合的领域边界是什么？
2. 包含哪些核心实体？
3. 主要的业务规则是什么？

User:
领域边界：用户身份验证和授权
核心实体：User（用户）、Session（会话）、Permission（权限）
业务规则：
- 用户必须通过验证才能访问系统
- 会话有效期为 24 小时
- 密码必须符合强度要求

AI: 很好！我会将这些信息保存到草稿。

[AI 调用 MCP 工具 update_node 保存草稿...]

✅ 草稿已保存！

当前草稿内容：
---
# 用户认证聚合根

## 领域边界
用户身份验证和授权

## 核心实体
1. User（用户）- 系统用户账户
2. Session（会话）- 用户登录会话
3. Permission（权限）- 访问控制权限

## 业务规则
1. 用户必须通过验证才能访问系统
2. 会话有效期为 24 小时
3. 密码必须符合强度要求（至少 8 字符，包含大小写字母和数字）

## 聚合根职责
- 管理用户生命周期（注册、激活、禁用）
- 验证用户身份（登录、登出）
- 管理会话状态
- 权限检查和授权
---

你可以：
1. 继续编辑: /ads.edit agg_a1b2c3d4
2. 定稿这些更改: /ads.finalize agg_a1b2c3d4
3. 放弃草稿（告诉我放弃即可）
```

### 3.3 定稿聚合根并自动创建下游节点

```
User: /ads.finalize agg_a1b2c3d4

AI: [调用 MCP 工具 get_node 检查草稿...]

📋 准备定稿: 用户认证 (agg_a1b2c3d4)

草稿内容:
---
# 用户认证聚合根
（内容省略）
---

这将会：
✅ 创建版本 v1
📁 保存到: docs/specs/用户认证_a1b2/aggregate_v1.md
🔄 触发自动工作流流转

是否继续？ (yes/no)

User: yes

AI: [调用 MCP 工具 finalize_node...]

✅ 已定稿为 v1！

📁 保存到: docs/specs/用户认证_a1b2/aggregate_v1.md

🔄 工作流进度:
- 已创建新节点: req_abc123 "用户认证 - 需求"
- 类型: requirement
- AI 生成: 已启用

🎯 下一步:
1. 编辑需求节点: /ads.edit req_abc123
2. 在 Web UI 查看: http://localhost:5173/graph
3. 查询完整状态: /ads.query

💡 AI 正在后台为新节点生成需求内容。
   几分钟后检查节点，或者现在就开始编辑来提供你自己的需求。
```

### 3.4 编辑需求节点

```
User: /ads.edit req_abc123

AI: [调用 MCP 工具 get_node...]

📝 编辑: 用户认证 - 需求 (req_abc123)
类型: requirement
当前版本: v0

📄 当前定稿内容:
---
（尚无定稿内容）
---

✏️ 当前草稿:
（AI 生成的初步需求，或者为空）

你想添加或修改什么？

User: 我需要添加以下用户故事：
1. 用户可以用邮箱注册账号
2. 用户可以用邮箱或手机号登录
3. 用户可以重置忘记的密码
4. 管理员可以禁用用户账号

AI: 好的，我会添加这些用户故事到需求中。

[更新草稿内容...]
[调用 MCP 工具 update_node...]

✅ 草稿已保存！

更新后的草稿:
---
# 用户认证需求

## 功能描述
系统需要提供完整的用户认证和授权功能，支持多种登录方式。

## 用户故事

### US-1: 用户注册
**作为** 新用户
**我希望** 能用邮箱注册账号
**以便于** 访问系统功能

**验收标准:**
- 提供邮箱和密码即可注册
- 密码强度验证（至少 8 字符，包含大小写字母和数字）
- 注册成功后发送验证邮件

### US-2: 用户登录
**作为** 已注册用户
**我希望** 能用邮箱或手机号登录
**以便于** 快速访问我的账户

**验收标准:**
- 支持邮箱登录
- 支持手机号登录
- 登录失败 5 次后锁定账户 15 分钟

### US-3: 密码重置
**作为** 用户
**我希望** 能重置忘记的密码
**以便于** 恢复账户访问

**验收标准:**
- 通过邮箱或手机号验证身份
- 生成安全的重置链接
- 重置链接 24 小时内有效

### US-4: 账户管理
**作为** 管理员
**我希望** 能禁用用户账号
**以便于** 管理违规用户

**验收标准:**
- 管理员可以禁用/启用用户账号
- 禁用的账号无法登录
- 记录操作日志

## 非功能需求
- 响应时间: 登录操作在 2 秒内完成
- 安全性: 密码必须加密存储
- 并发: 支持 1000 并发用户
---

想要：
1. 继续完善需求？
2. 定稿需求: /ads.finalize req_abc123
```

### 3.5 定稿需求并继续流转

```
User: /ads.finalize req_abc123

AI: [定稿流程，类似之前...]

✅ 已定稿为 v1！

🔄 工作流进度:
- 已创建新节点: design_def456 "用户认证 - 设计方案"
- 类型: design
- AI 生成: 已启用

💡 AI 正在根据你的需求生成设计方案。
```

### 3.6 查询工作流状态

```
User: /ads.query

AI: [调用 MCP 工具查询...]

📊 你的工作流
═══════════════════════════════════════

1. 用户认证 (DDD Standard)
   Root: agg_a1b2c3d4
   Status: 设计阶段
   Progress: 2/4 节点已定稿
   Last Updated: 5 分钟前

   节点状态:
   ├─ 🟢 aggregate: v1 (已定稿)
   ├─ 🟢 requirement: v1 (已定稿)
   ├─ 🟡 design: 草稿 (进行中)
   └─ ⚪ implementation: (尚未创建)

总计: 1 个活跃工作流

💡 使用 /ads.edit design_def456 来编辑设计方案
```

### 3.7 获取完整上下文进行代码实现

```
User: /ads.context impl_xyz789

AI: [调用 MCP 工具获取节点及所有父节点...]

🌳 完整上下文: 用户认证 - 实现方案
════════════════════════════════════════════════

📍 目标节点: impl_xyz789
类型: implementation
版本: v0 (未定稿)
状态: 草稿进行中

🔗 祖先链:
└─ 1. 用户认证 (aggregate, v1)
   └─ 2. 用户认证 - 需求 (requirement, v1)
      └─ 3. 用户认证 - 设计方案 (design, v1)
         └─ 4. 用户认证 - 实现方案 (implementation, v0) ← 你在这里

📄 内容总结:

1️⃣ 用户认证 (聚合根)
---
领域: 用户身份验证和授权
边界: ...
核心实体: User, Session, Permission
业务规则: ...
---

2️⃣ 用户认证 - 需求
---
功能描述: 完整的认证和授权功能
用户故事:
- US-1: 用户注册
- US-2: 用户登录
- US-3: 密码重置
- US-4: 账户管理
验收标准: ...
---

3️⃣ 用户认证 - 设计方案
---
架构: 微服务架构
认证方式: JWT Token
数据库: PostgreSQL
API 端点:
- POST /api/auth/register
- POST /api/auth/login
- POST /api/auth/reset-password
- POST /api/admin/users/{id}/disable
技术栈: FastAPI, SQLAlchemy, Redis
---

4️⃣ 用户认证 - 实现方案 (当前)
---
✏️ 草稿:
文件结构:
- api/v1/endpoints/auth.py
- api/v1/endpoints/admin.py
- models/user.py
- schemas/auth.py
- services/auth_service.py
- services/session_service.py

核心实现:
1. User Model
2. Session Management
3. Password Hashing (bcrypt)
4. JWT Token Generation
5. Permission Checking
---

📁 文件位置:
- 聚合根: docs/specs/用户认证_a1b2/aggregate_v1.md
- 需求: docs/specs/用户认证_a1b2/requirements_v1.md
- 设计: docs/specs/用户认证_a1b2/design_v1.md
- 实现: docs/specs/用户认证_a1b2/implementation_v0.md (草稿)

🎯 工作流状态:
模板: ddd_standard
阶段: 实现 (步骤 4/4)
下一步: 代码生成和测试

💡 现在你有了完整的上下文，可以：
1. 继续完善实现计划: /ads.edit impl_xyz789
2. 根据设计开始编写代码
3. 完成后定稿: /ads.finalize impl_xyz789
```

---

## 4. 工作流模板

### 4.1 DDD Standard (ddd_standard)

完整的 DDD 开发流程：

```
aggregate (聚合根)
    ↓ 定稿后自动创建
requirement (需求)
    ↓ 定稿后自动创建
design (设计)
    ↓ 定稿后自动创建
implementation (实现)
```

### 4.2 Bugfix (bugfix)

Bug 修复流程：

```
bug (Bug 报告)
    ↓ 定稿后自动创建
analysis (根因分析)
    ↓ 定稿后自动创建
fix (修复方案)
    ↓ 定稿后自动创建
test (测试验证)
```

### 4.3 Quick Feature (quick_feature)

快速功能开发：

```
feature (功能描述)
    ↓ 定稿后自动创建
implementation (实现)
```

---

## 5. 最佳实践

### 5.1 草稿 vs 定稿

- **草稿**: 可以随时编辑，不触发工作流流转，多次保存
- **定稿**: 创建版本快照，保存到文件系统，触发自动流转到下游节点

💡 **建议**: 在草稿阶段充分完善内容，定稿前确认无误

### 5.2 AI 生成 vs 人工编辑

- **AI 生成**: 定稿后自动为下游节点生成初步内容（如果启用）
- **人工编辑**: 使用 `/ads.edit` 手动编辑和完善

💡 **建议**: AI 生成提供起点，人工编辑确保质量

### 5.3 使用上下文

在编写实现代码前，使用 `/ads.context` 获取完整上下文：
- 查看所有上游决策
- 理解需求和设计
- 确保实现符合规范

### 5.4 查询工作流

定期使用 `/ads.query` 检查：
- 所有工作流的状态
- 哪些节点需要处理
- 工作流进度

---

## 6. 与 Web UI 的配合

虽然 Slash Commands 提供了完整的 CLI 工作流，但 Web UI 仍然有用：

- **可视化图谱**: 在 `http://localhost:5173/graph` 查看工作流结构
- **历史版本**: 查看节点的版本历史和差异
- **并行工作**: 多人协作时，可以同时使用 CLI 和 Web UI

---

## 7. 故障排除

### 7.1 MCP 连接失败

```
错误: MCP server not found
```

**解决**:
```bash
# 检查 MCP server 是否运行
pdm run python -m ads.mcp.server

# 检查 .mcp.json 配置是否正确
cat .mcp.json
```

### 7.2 工作空间未初始化

```
错误: Workspace not initialized
```

**解决**:
```bash
ads init --ai claude
```

### 7.3 节点不存在

```
错误: Node not found
```

**解决**:
```
# 使用 /ads.query 查看所有节点
/ads.query

# 确认节点 ID 正确
```

### 7.4 定稿失败

```
错误: No draft content to finalize
```

**解决**:
```
# 先编辑节点创建草稿
/ads.edit <node_id>

# 然后再定稿
/ads.finalize <node_id>
```

---

## 8. 完整示例总结

### 完整命令序列

```bash
# 1. 初始化项目
ads init --ai claude

# 2. 启动 MCP Server (在后台或单独终端)
pdm run python -m ads.mcp.server &

# 3. 启动 Claude Code
claude

# 4. 在 Claude Code 中创建工作流
/ads.new
> ddd_standard
> 用户认证

# 5. 编辑聚合根
/ads.edit agg_xxx
> (对话式编辑内容)

# 6. 定稿聚合根
/ads.finalize agg_xxx

# 7. 编辑需求
/ads.edit req_yyy
> (添加用户故事)

# 8. 定稿需求
/ads.finalize req_yyy

# 9. 编辑设计
/ads.edit design_zzz
> (添加架构设计)

# 10. 定稿设计
/ads.finalize design_zzz

# 11. 获取完整上下文
/ads.context impl_www

# 12. 根据上下文编写代码
> (在 Claude Code 中实现功能)

# 13. 编辑实现文档
/ads.edit impl_www
> (记录实现细节)

# 14. 定稿实现
/ads.finalize impl_www

# 15. 查看最终状态
/ads.query
```

---

## 9. 与 Spec-Kit 的对比

| 特性 | Spec-Kit | Ads Slash Commands |
|------|----------|-------------------|
| 初始化 | `specify init` | `ads init --ai claude` |
| 创建规范 | `/speckit.specify` | `/ads.new` |
| 创建计划 | `/speckit.plan` | `/ads.edit` (草稿系统) |
| 生成任务 | `/speckit.tasks` | 自动工作流流转 |
| 实现 | `/speckit.implement` | `/ads.context` + 代码实现 |
| 数据存储 | 文件系统 | **数据库 + 文件系统** |
| 可视化 | 无 | **Web UI** |
| AI 支持 | shell 脚本调用 | **MCP 工具** |
| 草稿系统 | 无 | **有（草稿 → 定稿）** |
| 版本控制 | Git | **内置版本快照 + Git** |

**Ads 的优势**:
- ✅ 数据库持久化，支持复杂查询
- ✅ 可视化 Web UI（可选）
- ✅ 草稿系统，支持迭代编辑
- ✅ 内置版本管理
- ✅ 自动工作流流转
- ✅ MCP 原生集成

---

## 10. 下一步

现在你已经了解了 Ads Slash Commands，可以：

1. **初始化你的第一个项目**: `ads init --ai claude`
2. **创建你的第一个工作流**: `/ads.new`
3. **体验完整的流程**: 从需求 → 设计 → 实现
4. **查看文档**: docs/specs/ 目录下的生成文件
5. **使用 Web UI**: 在 http://localhost:5173 可视化你的工作流

**祝你使用愉快！** 🚀
