# AD 工作空间设置指南

## 概念

ADS 是一个**工具系统**，用于辅助开发**其他项目**。

- **AD 项目**: 工具本身的代码（安装一次，全局使用）
- **工作空间**: 你正在开发的项目（电商系统、博客、等等）

## 快速开始

### 1. 全局安装 AD（一次性）

```bash
git clone https://github.com/your-repo/ad
cd ad
pdm install
```

### 2. 配置 Claude Code（一次性）

在 `~/.claude/config.json` 中配置：

```json
{
  "mcpServers": {
    "ad": {
      "command": "pdm",
      "args": ["run", "python", "-m", "ads.mcp.server"],
      "cwd": "/path/to/ad",
      "description": "ADS"
    }
  }
}
```

**注意**: `cwd` 必须指向 AD 项目目录（不是工作空间）。

### 3. 初始化工作空间

在你的项目目录：

```bash
cd /path/to/your-project

# 方式 A: 使用 Claude
claude
> 初始化当前目录为 AD 工作空间

# 方式 B: 使用命令行
pdm run python -c "from ads.workspace import WorkspaceDetector; WorkspaceDetector.initialize()"
```

这将创建：

```
your-project/
├── src/              # 你的代码
├── tests/            # 你的测试
├── .ads/              # AD 工作空间数据 ⭐
│   ├── workspace.json
│   ├── ads.db
│   └── rules/
└── docs/
    └── specs/        # 工作流 specs ⭐
```

### 4. 开始使用

```bash
cd /path/to/your-project
claude

> 创建一个用户登录功能的 DDD 工作流
```

所有数据会存储在**你的项目**中，而不是 AD 项目中！

## 目录结构

### AD 项目（工具）

```
/home/user/tools/ad/
├── ads/       # 源代码
├── .mcp.json           # 本地测试配置
└── pyproject.toml      # 依赖
```

### 工作空间项目（你的项目）

```
/home/user/projects/my-ecommerce/
├── src/                    # 你的代码
├── tests/                  # 你的测试
├── .ads/                    # AD 数据 ⭐
│   ├── workspace.json      # 工作空间配置
│   ├── ads.db    # 节点数据库
│   └── rules/              # 项目规则
│       └── workspace.md    # 工作空间特定规则
└── docs/
    └── specs/              # 工作流 specs ⭐
        ├── workflow_001/
        │   ├── requirement.md
        │   ├── design.md
        │   └── implementation.md
        └── workflow_002/
```

## 工作空间检测

AD 自动检测工作空间（优先级从高到低）：

1. **环境变量 `AD_WORKSPACE`**
2. **向上查找 `.ads/workspace.json`**
3. **向上查找 `.git` 目录（Git 根目录）**
4. **当前目录**

## 高级配置

### 项目级配置（可选）

如果你想为特定项目指定配置，在项目根目录创建 `.claude.json`：

```json
{
  "mcpServers": {
    "ad": {
      "command": "pdm",
      "args": ["run", "python", "-m", "ads.mcp.server"],
      "cwd": "/path/to/ad",
      "env": {
        "AD_WORKSPACE": "/path/to/this-project"
      }
    }
  }
}
```

### 多项目开发

可以同时开发多个项目，每个项目有独立的：
- 数据库（`.ads/ads.db`）
- 规则（`.ads/rules/`）
- Specs（`docs/specs/`）

```bash
# 项目 A
cd ~/projects/project-a
claude
> 创建工作流 A

# 项目 B
cd ~/projects/project-b
claude
> 创建工作流 B
```

两个项目的数据完全隔离！

## 版本控制

建议将工作空间数据纳入版本控制：

```.gitignore
# 提交这些
.ads/workspace.json
.ads/rules/
docs/specs/

# 不提交数据库（每个开发者独立）
.ads/ads.db
```

## 常见问题

### Q: 为什么要分离 AD 项目和工作空间？

A:
- **AD 项目**是工具，全局安装一次
- **工作空间**是你的业务项目，可以有多个
- 数据存在工作空间，方便团队协作和版本控制

### Q: 如何知道当前工作空间？

```
claude> 显示当前工作空间信息
```

### Q: 如何迁移旧数据？

如果你之前的数据在 AD 项目中：

```bash
cd ~/projects/my-project

# 初始化工作空间
claude> 初始化工作空间

# 手动复制数据
cp ~/tools/ad/ads.db .ads/
cp -r ~/tools/ad/docs/specs/* docs/specs/
```

### Q: 能否不初始化直接使用？

可以，但：
- 数据会存在 Claude 当前目录（可能不是你想要的）
- 缺少工作空间标记，自动检测可能不准确

建议总是先初始化工作空间。

## 验证工作空间

初始化后，可以验证工作空间是否正确配置：

```bash
cd /path/to/your-project
claude

> 显示当前工作空间信息
```

应该看到：
- `path`: 你的项目路径
- `is_initialized`: true
- `db_path`: `.ads/ads.db`
- `rules_dir`: `.ads/rules/`
- `specs_dir`: `docs/specs/`

## 工作空间自动检测

系统已全面更新为工作空间感知模式，无需每次手动指定路径：

✅ **数据库**: 自动存储在 `{workspace}/.ads/ads.db`
✅ **规则**: 自动读写 `{workspace}/.ads/rules/`
✅ **Specs**: 自动保存到 `{workspace}/docs/specs/`

所有核心组件都已更新：
- `database.py`: 数据库连接自动使用工作空间路径
- `file_manager.py`: Spec 文件自动保存到工作空间
- `rules/file_manager.py`: 规则文件自动使用工作空间目录

## 总结

1. ✅ AD 项目全局安装一次
2. ✅ 在 `~/.claude/config.json` 配置一次
3. ✅ 每个项目初始化工作空间
4. ✅ 数据自动存储在你的项目中，不是 AD 中
5. ✅ 支持多项目并行开发
6. ✅ 自动工作空间检测，无需手动指定路径
7. ✅ 所有核心组件已更新为工作空间感知模式

现在可以愉快地使用 ADS 了！🚀
