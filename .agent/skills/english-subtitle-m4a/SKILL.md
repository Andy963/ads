---
name: english-subtitle-m4a
description: "Convert uploaded English MP3/M4A audio into one M4A with embedded sentence-aligned English-above-Chinese lyrics, then send it to the current Telegram chat. Use for 英语精听, 单句复读, 中英字幕, 加字幕, 内嵌歌词, 转 m4a 字幕."
requires:
  env: [GROQ_API_KEY, TELEGRAM_BOT_TOKEN]
  tools: [bash, python3]
channels: [telegram]
allowed-tools: [bash]
---

# English Subtitle M4A

## 功能

当 Telegram 用户上传英文音频，并要求制作精听、单句复读或中英字幕版本时使用本 skill。

脚本会：

- 使用 Groq Whisper 获取英文词级时间戳。
- 按句末标点、语音停顿和从句边界重建字幕，避免长句或多句对白粘在同一行。
- 在最终切分完成后逐条翻译为简体中文，严格保持英文与中文一一对应。
- 为每个时间点连续写入英文行和中文行，显示顺序固定为英文在上、中文在下。
- 将歌词写入 M4A 的 `©lyr` 标签。
- 每个输入只保留一个最终 `.m4a`，不生成或发送 `.mp3`、`.lrc`、`.json`、`.html` 等 sidecar。
- 根据请求将最终 M4A 发回当前 Telegram 对话。

默认输出文件名后缀为 `-sub-zh.m4a`。

## 硬性输出要求

- 最终交付只允许 `.m4a`，不要额外保留或发送 `.mp3`、`.lrc`、`.json`、`.html`。
- M4A 必须写入 `©lyr` 内嵌歌词标签。
- 每条字幕必须是同一个时间戳连续两行：
  1. 第一行英文原文。
  2. 第二行对应简体中文翻译。
- 先完成英文句子切分，再逐条翻译；不得先整段翻译后再切分。
- 如英文行过长、时间跨度过长或包含多个自然句，必须重新切分，不要把长句粘成一条歌词。
- 输出前必须抽查或程序校验：英文行不含中文，中文行包含中文字符，且中英文时间戳一一对应。

## 长句切分策略

切分优先级如下：

1. 句末标点和明显语音停顿。
2. 逗号、分号、破折号及自然从句连接位置。
3. 当一条字幕仍超过默认的 18 个单词、96 个字符或 9 秒时，才使用接近自然边界的长度兜底切分。

翻译发生在切分之后，因此每条英文与其下方中文共享同一时间戳，不允许翻译模型合并、拆分、遗漏或重排字幕。

如音频节奏特殊，可通过以下参数调整：

```bash
python3 ${SKILL_DIR}/scripts/subtitle_m4a.py \
  --input "/path/to/audio.mp3" \
  --max-words 14 \
  --max-chars 84 \
  --max-seconds 6 \
  --pause-threshold 0.65
```

对儿童故事、精听材料或用户明确担心长句时，优先使用上面的更严格阈值。

## 环境要求

不要在聊天中向用户索取或展示密钥。

必须存在：

- `GROQ_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `ADS_TELEGRAM_CHAT_ID`，通常由 `ads-tg` 在 Telegram 会话中注入

可选配置：

- `ADS_GROQ_WHISPER_MODEL` 或 `GROQ_WHISPER_MODEL`
- `ADS_GROQ_TRANSLATION_MODEL` 或 `GROQ_TRANSLATION_MODEL`

默认翻译模型为 `qwen/qwen3.6-27b`，并关闭 reasoning 输出，以稳定获得仅包含字幕映射的 JSON。翻译结果若缺少中文字符、混入西里尔文/日文/韩文，或字幕 ID 发生遗漏、重复、重排，会直接失败并重试，不写出低质量成品。

音频转换还需要以下任一条件：

- `ffmpeg` 位于 `PATH`
- `FFMPEG_BINARY=/absolute/path/to/ffmpeg`
- 项目已安装 `ffmpeg-static`

## Telegram 工作流

`ads-tg` 收到音频或文档后，会保存到本地并在 prompt 中提供路径，例如：

```text
Uploaded files:
- lesson.mp3: /path/to/downloaded/lesson.mp3
```

运行：

```bash
python3 ${SKILL_DIR}/scripts/subtitle_m4a.py \
  --input "/path/to/downloaded/lesson.mp3" \
  --send-telegram
```

如需保留本地最终文件：

```bash
python3 ${SKILL_DIR}/scripts/subtitle_m4a.py \
  --input "/path/to/downloaded/lesson.mp3" \
  --send-telegram \
  --keep-output \
  --caption "Bilingual sentence subtitles embedded in M4A."
```

命令成功后，只需简短回复 M4A 已发送。除非用户明确要求，不要粘贴转录或翻译全文。

## 本地工作流

本地生成但不发送 Telegram：

```bash
python3 ${SKILL_DIR}/scripts/subtitle_m4a.py \
  --input "/path/to/audio.mp3" \
  --output-dir "/path/to/output"
```

持久化输出目录中只应新增一个 `.m4a`。脚本打印输出路径、字幕条数和翻译模型。

## 校验

运行纯逻辑测试：

```bash
python3 -m unittest discover \
  -s ${SKILL_DIR}/tests \
  -p "test_*.py"
```

交付前应确认：

- 输出扩展名只有 `.m4a`。
- `©lyr` 标签存在且非空。
- 每个时间戳先出现英文，下一行出现对应中文。
- 长句优先在停顿或从句边界切分，不出现明显断裂。
- 音频时长与输入基本一致。

## 隐私规则

- 不得打印 API key、bot token、`.env` 内容或 Telegram 文件 URL。
- 缺少密钥时，只提示用户自行配置运行环境。
- 未经明确许可，不得编辑 `.env`、systemd unit、shell profile 或 secret store。
