# ADS Slash Commands - Git-like Workflow Management

这些 slash commands 让你像使用 git 一样管理工作流。

## 核心理念

**工作流 = Git 分支**
- 每个工作流就像一个 git 分支
- 通过步骤名称引用节点（如 `report`, `analysis`），无需记住 node ID
- 活动工作流自动跟踪（类似 git 当前分支）

## 命令列表

### 📋 ads.branch - 列出所有工作流
```bash
/ads.branch
```
显示所有工作流，标记当前活动的工作流（类似 `git branch`）

### 🔀 ads.checkout - 切换工作流
```bash
/ads.checkout <workflow>
```
切换到不同的工作流（类似 `git checkout`）

支持模糊匹配：
```bash
/ads.checkout 登录      # 匹配 "登录页面重复提交"
/ads.checkout bugfix    # 模糊匹配
/ads.checkout bug_123   # 精确 ID 匹配
```

### 📊 ads.status - 显示工作流状态
```bash
/ads.status
```
显示当前工作流的详细状态（类似 `git status`）
- 所有步骤及其状态
- 当前正在处理的步骤
- 草稿信息
- 下一步建议

### 💼 ads.work - 指示工作步骤
```bash
/ads.work <step>
```
显式指示你正在处理某个步骤（可选命令）

**通常不需要** - Claude 会自动识别上下文
**何时使用**：
- 切换到不同步骤时
- 需要明确当前上下文时
- Claude 不确定你指的哪个步骤时

示例：
```bash
/ads.work analysis   # Bug 分析步骤
/ads.work design     # 设计步骤
/ads.work fix        # Bug 修复步骤
```

### ✅ ads.commit - 定稿并流转
```bash
/ads.commit <step>
```
定稿当前步骤并自动创建下一步（类似 `git commit`）

示例：
```bash
/ads.commit report     # 定稿 bug 报告
/ads.commit analysis   # 定稿分析，自动创建 fix 步骤
/ads.commit           # 定稿当前步骤（隐式）
```

**自动流转**：
```
report (commit) → analysis (created)
analysis (commit) → fix (created)
fix (commit) → verify (created)
```

### 🆕 ads.new - 创建新工作流
```bash
/ads.new <type> <title>
```
创建新的工作流并自动设为活动工作流

**工作流类型**：
- `bugfix` - Bug 修复流程 (4 步: report → analysis → fix → verify)
- `ddd_standard` - DDD 开发流程 (4 步: aggregate → requirement → design → implementation)
- `quick_feature` - 快速功能开发 (2 步: feature → implementation)

示例：
```bash
/ads.new bugfix "登录页面重复提交"
/ads.new ddd_standard "用户认证"
/ads.new quick_feature "数据导出"
```

## 工作流步骤名称

### Bugfix 工作流
- `report` - Bug 报告
- `analysis` - Bug 分析
- `fix` - Bug 修复
- `verify` - Bug 验证

### DDD Standard 工作流
- `aggregate` - 聚合根
- `requirement` - 需求分析
- `design` - 设计方案
- `implementation` - 实现方案

### Quick Feature 工作流
- `feature` - 功能描述
- `implementation` - 实现方案

## 典型工作流示例

### 创建并完成一个 Bug 修复

```bash
# 1. 创建 bug 工作流
/ads.new bugfix "登录重复提交"

# Claude 会收集信息并创建完整的 bug 报告

# 2. 查看状态
/ads.status

# 3. 定稿报告，自动创建 analysis 步骤
/ads.commit report

# 4. 讨论分析（自然对话，无需命令）
User: 让我们分析这个问题的根本原因
Claude: [自动识别是在处理 analysis 步骤]

# 5. 定稿分析，自动创建 fix 步骤
/ads.commit analysis

# 6. 讨论修复方案
User: 我们应该在前端添加防抖逻辑
Claude: [更新 fix 步骤的内容]

# 7. 定稿修复，自动创建 verify 步骤
/ads.commit fix

# 8. 定稿验证，完成工作流
/ads.commit verify

# 9. 查看所有工作流
/ads.branch
```

### 管理多个并行工作流

```bash
# 当前在 bugfix-login 工作流

# 1. 列出所有工作流
/ads.branch

# 2. 切换到 DDD 工作流
/ads.checkout 用户认证

# 3. 继续 DDD 工作
/ads.status
/ads.work design
# ... 编辑设计 ...
/ads.commit design

# 4. 切换回 bugfix
/ads.checkout 登录

# 5. 继续 bugfix 工作
/ads.status
```

## Git vs ADS 命令对照

| Git 命令 | ADS 命令 | 说明 |
|----------|----------|------|
| `git branch` | `/ads.branch` | 列出所有分支/工作流 |
| `git checkout <branch>` | `/ads.checkout <workflow>` | 切换分支/工作流 |
| `git status` | `/ads.status` | 查看当前状态 |
| `git commit` | `/ads.commit <step>` | 提交/定稿 |
| `git log` | 版本历史（UI） | 查看历史 |
| `git add` | 草稿区 | 暂存更改 |

## 重要概念

### 活动工作流（Active Workflow）
- 类似 git 的当前分支
- 存储在 `.ads/context.json`
- 创建新工作流时自动设为活动
- 使用 `/ads.checkout` 切换

### 步骤名称（Step Names）
- 代替 node ID，更易记
- 根据工作流模板自动映射
- 例：`report` → `bug_report_abc123`

### 草稿 vs 定稿（Draft vs Finalized）
- **草稿**：可以随时修改的内容
- **定稿**：创建不可变版本快照
- 定稿时自动创建下一步

### 自动流转（Auto-progression）
- 定稿一个步骤自动创建下一步
- 无需手动创建节点
- 遵循工作流模板定义的顺序

## 文件结构

```
.ads/
├── context.json          # 活动工作流上下文
├── ads.db               # SQLite 数据库
└── specs/               # 工作流文档
    └── <workflow_id>/   # 每个工作流一个目录
        ├── README.md    # 工作流索引
        ├── bug_report.md
        ├── bug_analysis.md
        ├── bug_fix.md
        └── bug_verify.md
```

## 与 Git 的区别

✅ **相似点**：
- 分支概念（工作流）
- 提交概念（定稿）
- 状态查看
- 切换分支

⚠️ **不同点**：
- **无 staging area** - 草稿就是 staging area
- **无 merge conflicts** - 单线程工作流
- **自动流转** - 提交自动创建下一步
- **无需 push/pull** - 自动保存到文件系统
- **步骤顺序** - 必须按顺序完成步骤

## 最佳实践

1. **优先使用自然对话** - 只在需要时使用显式命令
2. **定期 commit** - 完成一个步骤就定稿
3. **描述性标题** - 创建工作流时使用清晰的标题
4. **完整内容** - 创建时提供完整信息，不要留空
5. **查看状态** - 不确定时使用 `/ads.status`
6. **模糊匹配** - 切换工作流时使用关键词即可

## 故障排除

### 找不到工作流
```bash
/ads.branch           # 查看所有可用工作流
/ads.checkout <确切名称>
```

### 无法提交步骤
```bash
/ads.status          # 检查是否有草稿内容
# 确保步骤有内容后再提交
```

### 不知道当前在哪个工作流
```bash
/ads.status          # 显示当前活动工作流
/ads.branch          # 查看所有工作流，*标记当前
```

## 更多信息

查看各个命令的详细文档：
- [ads.branch.md](./ads.branch.md)
- [ads.checkout.md](./ads.checkout.md)
- [ads.status.md](./ads.status.md)
- [ads.work.md](./ads.work.md)
- [ads.commit.md](./ads.commit.md)
- [ads.new.md](./ads.new.md)
