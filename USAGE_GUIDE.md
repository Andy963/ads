# ADS-JS 使用指南

## 启动客户端

```bash
npx tsx ads-client.ts
```

---

## 常用命令

### 1. 创建工作流

```bash
AGENT> /ads.new feature 插件功能
AGENT> /ads.new bugfix 修复登录问题
AGENT> /ads.new standard 完整开发流程
```

**支持的工作流类型**:
- `feature` - 快速功能开发（需求 → 实现）
- `bugfix` - Bug修复流程（报告 → 分析 → 修复 → 验证）
- `standard` - 标准开发流程（聚合根 → 需求 → 设计 → 实现）

---

### 2. 查看所有工作流

```bash
AGENT> /ads.branch

# 输出示例：
现有工作流：
1. [feature] 插件功能 (nodes: 3, finalized: 1) - req_abc123
2. [bugfix] 修复登录 (nodes: 4, finalized: 2) - bug_def456
3. [standard] 用户系统 (nodes: 5, finalized: 0) - agg_ghi789
```

**删除工作流**:
```bash
# 用序号删除（推荐）
AGENT> /ads.branch -d 2
✅ 已删除工作流: 修复登录

# 用标题删除
AGENT> /ads.branch -d 插件
✅ 已删除工作流: 插件功能

# 强制删除（-D）
AGENT> /ads.branch -D 1
✅ 已删除工作流: 用户系统
```

---

### 3. 切换工作流 ⭐ 多种方式

**方式 1: 用序号（最简单！）**
```bash
AGENT> /ads.checkout 1
# 切换到第 1 个工作流
```

**方式 2: 用标题（部分匹配）**
```bash
AGENT> /ads.checkout 插件
# 匹配标题包含 "插件" 的工作流

AGENT> /ads.checkout 登录
# 匹配标题包含 "登录" 的工作流
```

**方式 3: 用 ID（不推荐，太长了）**
```bash
AGENT> /ads.checkout req_abc123
# 用完整 ID 切换
```

---

### 4. 查看当前工作流状态

```bash
AGENT> /ads.status

# 输出示例：
On workflow: 插件功能
Template: feature
ID: req_abc123

Steps:
  ✅ requirement: 插件功能 - 需求
  📝 implementation: 插件实现 - 实现 ← current

Progress: 50% (1/2)

💡 Next actions:
    - Add draft content: /ads.add <step> <content>
    - Finalize step: /ads.commit <step>
```

---

### 5. 添加步骤内容

```bash
AGENT> /ads.add requirement "实现用户登录功能，支持邮箱和手机号"
AGENT> /ads.add design "采用 JWT 认证方案"
```

---

### 6. 定稿步骤

```bash
AGENT> /ads.commit requirement
AGENT> /ads.commit design
```

---

### 7. 获取步骤详情

```bash
AGENT> /ads.get requirement
AGENT> /ads.get implementation
```

---

## 完整工作流示例

```bash
# 1. 创建新工作流
AGENT> /ads.new feature 用户登录

# 2. 查看状态
AGENT> /ads.status

# 3. 添加需求内容
AGENT> /ads.add requirement "支持邮箱和手机号登录，使用 JWT 认证"

# 4. 定稿需求
AGENT> /ads.commit requirement

# 5. 查看状态（会自动创建下一步）
AGENT> /ads.status

# 6. 添加实现内容
AGENT> /ads.add implementation "已实现登录 API 和前端组件"

# 7. 定稿实现
AGENT> /ads.commit implementation

# 8. 完成！查看最终状态
AGENT> /ads.status
```

---

## 切换工作流示例

```bash
# 先列出所有工作流
AGENT> /ads.branch
现有工作流：
1. [feature] 用户登录 (nodes: 2, finalized: 2) - req_abc123
2. [feature] 插件功能 (nodes: 1, finalized: 0) - req_def456
3. [bugfix] 修复注册 (nodes: 3, finalized: 1) - bug_ghi789

# 方式 1: 用序号（推荐！）
AGENT> /ads.checkout 2
已切换到工作流: 插件功能

# 方式 2: 用标题
AGENT> /ads.checkout 注册
已切换到工作流: 修复注册

# 方式 3: 部分匹配
AGENT> /ads.checkout 登录
已切换到工作流: 用户登录

# 确认切换成功
AGENT> /ads.status
On workflow: 用户登录
...
```

---

## 其他命令

### 查看最近的工作流

```bash
AGENT> /ads.log
```

### 获取节点详情

```bash
AGENT> /ads.get requirement
```

### 查看可用的工作流模板

```bash
# （这是内部命令，通常不需要直接调用）
```

---

## 提示

✅ **推荐**: 用序号切换工作流 `/ads.checkout 1`
✅ **推荐**: 用标题部分匹配 `/ads.checkout 插件`
❌ **不推荐**: 记忆并输入完整 ID

---

## 退出

```bash
AGENT> /exit
```

---

## 需要帮助？

如果输入错误的命令，系统会给出友好的提示：

```bash
AGENT> /ads.satus
❌ 工具不存在: ads.satus
💡 提示: 检查拼写或使用 /ads.status 查看可用命令

AGENT> /ads.checkout
❌ 缺少必需参数: workflow_identifier
💡 用法: ads.checkout <workflow_identifier>
```
