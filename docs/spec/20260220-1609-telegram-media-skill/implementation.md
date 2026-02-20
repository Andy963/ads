# Implementation: Telegram media skill

## 实现步骤

1. 新增 skill 目录与文档
   - `.agent/skills/telegram-media/SKILL.md`
2. 实现 `.env` 自动加载工具
   - `.agent/skills/telegram-media/scripts/env_loader.py`
3. 实现发送脚本
   - `.agent/skills/telegram-media/scripts/send.py`
   - 支持 `message/photo/audio/voice/video/document`
4. 实现下载脚本
   - `.agent/skills/telegram-media/scripts/download.py`
   - 默认输出到 `<project_root>/.ads/temp/telegram-downloads`
5. Telegram adapter 注入 reply message id
   - `src/telegram/adapters/codex.ts`
6. 更新 Gemini skills 文档
   - `.agent/skills/gemini-image-gen/SKILL.md`
   - `.agent/skills/gemini-image-edit/SKILL.md`
   - `.agent/skills/gemini-tts/SKILL.md`

## 文件清单

- `.agent/skills/telegram-media/SKILL.md`
- `.agent/skills/telegram-media/scripts/env_loader.py`
- `.agent/skills/telegram-media/scripts/send.py`
- `.agent/skills/telegram-media/scripts/download.py`
- `src/telegram/adapters/codex.ts`
- `.agent/skills/gemini-image-gen/SKILL.md`
- `.agent/skills/gemini-image-edit/SKILL.md`
- `.agent/skills/gemini-tts/SKILL.md`

## 测试建议

- `send.py`：
  - 在 `.env` 配置 `TELEGRAM_BOT_TOKEN` 与 `ADS_TELEGRAM_CHAT_ID`，发送一张图片与一段音频
- `download.py`：
  - 用一条已知消息的 `file_id` 进行下载，检查文件大小限制与落盘路径

## 验证方式（命令）

```bash
npx tsc --noEmit
npm run lint
npm test
```

