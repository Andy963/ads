# Design: Telegram media skill

## 总体思路

- 新增 workspace skill：`.agent/skills/telegram-media/`
- 以两个 Python 脚本实现：
  - `scripts/send.py`：调用 Telegram Bot API 的 `sendMessage/sendPhoto/sendAudio/sendVoice/sendVideo/sendDocument`
  - `scripts/download.py`：`getFile` + `/file/bot<TOKEN>/<file_path>` 下载
- 在脚本启动时加载 `.env`：
  - 支持 `ADS_ENV_PATH` 指定 `.env` 位置
  - 否则从 `cwd` 向上搜索 `.env`，遇到 `.git`/`package.json` 作为边界
  - `.env.local` 作为 override（覆盖同名 key）
  - 不覆盖进程已存在的环境变量（避免覆盖 Telegram 入口注入的 chat id / reply id）

## 关键设计点

- 参数设计：
  - `--token` / `--chat-id` / `--reply-to` 允许显式覆盖（便于本地调试）
  - 默认读取 `TELEGRAM_BOT_TOKEN` / `ADS_TELEGRAM_CHAT_ID` / `ADS_TELEGRAM_REPLY_TO_MESSAGE_ID`
- 下载落盘：
  - 默认输出目录固定到 `<project_root>/.ads/temp/telegram-downloads`，避免 `/cd` 后散落到子目录
  - 若目标文件名冲突，自动追加 `_N` 后缀

## 风险与处理

- Bot API 对 `voice` 格式要求严格（OGG/OPUS）；因此不自动转码，提示用户使用 `audio` 类型发送 WAV。
- 网络/代理不通：
  - 支持 `TELEGRAM_PROXY_URL`
  - 统一使用 httpx 超时并输出可读错误

## 兼容性

- 不变更现有数据库与协议。
- Telegram adapter 仅增加一个 env 注入，不影响现有消息处理逻辑。

