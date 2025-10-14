# ADS 全局安装指南

## 为什么需要全局安装？

如果你只在 AD 项目中配置了 MCP server，那么：
- ✅ 在 AD 项目中：Claude Code 可以使用 ADS
- ❌ 在其他项目中：Claude Code 完全不知道 ADS 的存在

**解决方案：将 ADS 安装为全局可用的 MCP server**

## 安装步骤

### 步骤 1：安装 ADS 包

ADS 必须作为 Python 包安装，这样才能在任何目录被导入。

```bash
# 克隆仓库（如果还没有）
git clone https://github.com/your-org/ad-assistant.git
cd ad-assistant

# 安装为可编辑模式的包
pdm install

# 或使用 pip
pip install -e .
```

### 步骤 2：验证安装

在**任意目录**运行以下命令验证：

```bash
python -c "import ads; print('✓ ADS 已安装成功')"
```

如果没有报错，说明安装成功！

### 步骤 3：配置全局 MCP Server

使用 Claude Code CLI 添加全局 MCP server：

```bash
claude mcp add ad --scope user --transport stdio -- python -m ads.mcp.server
```

参数说明：
- `ad`: MCP server 名称
- `--scope user`: 用户级别配置（对所有项目生效）
- `--transport stdio`: 使用标准输入输出通信
- `python -m ads.mcp.server`: 启动命令

### 步骤 4：验证配置

```bash
claude mcp list
```

应该看到：
```
ad: python -m ads.mcp.server - ✓ Connected
```

### 步骤 5：在任意项目中使用

现在，在**任何项目**中使用 Claude Code，都可以直接使用 ADS！

```bash
# 在任意项目目录
cd /path/to/your/other/project

# 启动 Claude Code
claude

# 现在可以使用 ADS 工具了！
> 帮我创建一个 DDD 标准工作流
```

## 配置文件位置

全局配置保存在：
- Windows: `C:\Users\<用户名>\.claude.json`
- macOS/Linux: `~/.claude.json`

配置格式：
```json
{
  "mcpServers": {
    "ad": {
      "type": "stdio",
      "command": "python",
      "args": ["-m", "ads.mcp.server"],
      "env": {}
    }
  }
}
```

## 常见问题

### Q: 为什么在别的项目中找不到 ADS？

A: 因为：
1. 没有将 ADS 安装为 Python 包，Python 无法在其他目录找到 `ads` 模块
2. 或者只配置了项目级 MCP server，没有配置全局 MCP server

### Q: 如何更新 ADS？

```bash
cd /path/to/ad-assistant
git pull
pdm install  # 重新安装
```

### Q: 如何卸载全局 MCP server？

```bash
claude mcp remove ad --scope user
```

### Q: 可以同时有多个 ADS MCP server 吗？

可以！例如：
- `ad`: 全局版本（稳定版）
- `ad-dev`: 开发版本（实验功能）

```bash
# 添加开发版
claude mcp add ad-dev --scope user --transport stdio -- python -m ads.mcp.server
```

## 项目级 vs 全局配置

| 配置方式 | 作用范围 | 配置方法 | 使用场景 |
|---------|---------|---------|---------|
| 项目级 | 仅当前项目 | 在项目根目录创建 `.mcp.json` | 项目特定配置 |
| 全局 | 所有项目 | `claude mcp add --scope user` | 常用工具、个人工具 |

**推荐做法：**
- 个人常用工具（如 ADS）→ 全局配置
- 项目特定工具 → 项目级配置

## 验证是否真正全局可用

在**不同的项目目录**测试：

```bash
# 项目 A
cd /path/to/project-a
claude
> @ad 帮我创建工作流  # 应该可以工作

# 项目 B
cd /path/to/project-b
claude
> @ad 当前工作空间信息  # 应该可以工作
```

如果都能正常使用，说明全局配置成功！

## 技术原理

1. **包安装**：`pdm install` 将 `ads` 添加到 Python 的 site-packages
2. **全局配置**：`claude mcp add --scope user` 将配置写入 `~/.claude.json`
3. **跨项目可用**：任何项目中，Claude Code 都会读取全局配置并启动 MCP server
4. **Python 导入**：因为包已安装，`python -m ads.mcp.server` 在任意目录都能运行

这就是为什么之前不工作的原因：包没有安装 + 没有全局配置！
