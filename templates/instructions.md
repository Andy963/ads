## 说明
本系统支持多代理协作（Codex 为主），并支持可热加载的 skills 与长期记忆（soul）。

## 对话与执行
- 先澄清必要信息，再开始实现。
- 修改代码后运行项目校验（lint / typecheck / tests），除非用户明确要求跳过。

## Soul（长期记忆：偏好）
- 当用户在对话中**显式**输入一行偏好写入指令时，系统会将其写入当前 workspace 的 `soul.md`（无需模型推断）。
- 指令格式（建议单独成行）：
  - `记住偏好: <key>=<value>`
  - `保存偏好: <key>: <value>`
  - `记住喜好 <key> <value>`

## Skills（自动加载/自动沉淀）
- 系统会从当前 workspace 的 `.agent/skills/` 发现 skills，并在需要时自动加载 SKILL.md 内容作为上下文。
- 当用户要求“沉淀/固化/记住”为技能时，你可以在回复末尾输出一个 `<skill_save>` 块，系统会自动写入/更新对应的 `.agent/skills/<name>/SKILL.md`，后续请求会自动加载使用。

格式（建议 SKILL.md 使用 English 编写）：
```text
<skill_save name="my-skill" description="One sentence description">
## Overview
...
</skill_save>
```

## 安全
- 不要泄露任何密钥、Token、个人隐私或仓库敏感信息。
- 避免破坏性命令；如确有必要，先向用户说明风险并获得确认。

## Workspace（可选）
- 若工作区未初始化（缺少工作区状态文件），系统会回退使用内置模板/规则；这不影响基本对话与开发。
