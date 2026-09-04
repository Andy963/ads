# ADS Telegram Bot

ADS 包含一个可选的 Telegram Bot 服务端入口。它不仅仅用于接收任务终态通知，更是一个全功能的远程对话与控制终端，支持在移动设备上无缝与 Agent 交互、执行命令、恢复会话及管理工作区。

---

## 快速配置与启动

### 1. 环境变量配置
在 `.env` 或环境变量中配置以下必填项：

```bash
# Telegram Bot Token (向 @BotFather 申请)
TELEGRAM_BOT_TOKEN="1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ"

# 授权的单用户 ID (向 @userinfobot 发送消息获取数字 ID)
TELEGRAM_ALLOWED_USER_ID="123456789"
```

### 2. 启动服务
```bash
# 先编译构建
npm run build

# 启动 Telegram Bot 守护进程
node dist/server/cli.js telegram
```

---

## 指令清单与交互说明

| 指令 | 参数 / 格式 | 说明 |
|---|---|---|
| `/start` | 无 | 欢迎信息与可用指令概览 |
| `/help` | 无 | 详细帮助文档与交互提示 |
| `/status` | 无 | 查看当前系统状态、活动 Agent 及当前工作目录 |
| `/reset` | 无 | 重置当前会话，开启全新的对话上下文 |
| `/sessions` | `[关键词]` (可选) | 搜索并列出当前工作目录下最近的 Codex / Claude 原生会话，点击内联按钮直接恢复上下文 |
| `/resume` | 无 | 快捷提示，引导使用 `/sessions` 选取恢复目标 |
| `/esc` | 无 | 紧急中断当前正在执行的任务或模型生成，保留 Agent 进程环境 |
| `/pwd` | 无 | 显示当前工作区绝对路径 |
| `/cd` | `<目标路径>` | 在 `ALLOWED_DIRS` 白名单允许的范围内切换当前工作区目录 |
| `/pref` | `[list \| add <key> <val> \| del <key>]` | 维护与查询工作区的长期偏好（写入 `soul.md`） |
| `/mark` | `[on \| off]` | 开启或关闭笔记标记模式，开启时后续对话会自动沉淀到当日 Note 中 |

---

## 多模态与特殊输入支持

1. **语音消息与音频转写**：
   - 发送语音消息（Voice Message）或音频文件（如 `.ogg`, `.m4a`, `.mp3`）。
   - 服务端自动调用内置语音转写模块（支持 Groq Whisper 等引擎），将语音转为文字并直接作为 Prompt 发送给 Agent。
2. **图片与文档附件**：
   - 发送图片直接作为多模态输入传递给支持 Vision 的模型。
   - 发送文本、代码或配置文档附件，Bot 会自动下载并将其路径注入到当前任务上下文。
3. **Web 调度通知联动**：
   - 当 Web 端创建的定时 Prompt 到达终态（成功 / 失败 / 取消）时，Bot 会按调度配置推送执行结果摘要。

---

## 安全与权限控制

- **严格单用户锁定**：ADS Telegram Bot 采用白名单校验机制，所有非 `TELEGRAM_ALLOWED_USER_ID` 的消息均会被静默丢弃或直接拦截拒绝，防止公共群组或未经授权的用户调用底层系统权限。
- **路径沙箱保护**：`/cd` 目录切换受 `ALLOWED_DIRS` 严格约束，无法越权访问白名单之外的宿主机文件系统。

---

## Telegram 相关环境变量

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 必填 | Telegram Bot API 访问凭据 |
| `TELEGRAM_ALLOWED_USER_ID` | 必填 | 唯一授权操作的 Telegram 用户数字 ID |
| `TELEGRAM_MAX_RPM` | `10` | 频率限制：单用户每分钟允许发送的最多请求数 |
| `TELEGRAM_SESSION_TIMEOUT` | `24h` | 会话空闲超时（例如 `24h`, `120m`，`0` 表示不超时） |
| `TELEGRAM_STREAM_UPDATE_INTERVAL` | `1500` | 流式消息向 Telegram 编辑推送的时间间隔（毫秒） |
| `TELEGRAM_MODEL` | 未设置 | Telegram 端使用的默认模型覆盖 |
| `TELEGRAM_PROXY_URL` | 未设置 | HTTP / SOCKS5 网络代理地址（如 `http://127.0.0.1:7890`） |
| `TELEGRAM_SILENT_NOTIFICATIONS` | `true` | 是否静默发送调度 Prompt 终态通知 |
| `ADS_TELEGRAM_NOTIFY_TIMEZONE` | `Asia/Shanghai` | 调度终态通知卡片中显示的时间时区 |
