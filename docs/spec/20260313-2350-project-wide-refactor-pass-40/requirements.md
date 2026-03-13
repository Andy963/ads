# Project-wide Refactor Pass 40 - Skill Creator Validation Helpers

## Goal

- 收敛 `server/skills/creator.ts` 中重复的 skill name 校验与 workspace skill 路径解析逻辑。
- 保持 skill init / auto-save 行为、错误语义与已有调用方契约不变。

## Requirements

- `initSkill()` 与 `saveSkillDraftFromBlock()` 必须复用同一套 skill name 归一化/合法性校验逻辑。
- workspace `.agent/skills/<name>` 路径解析与越界防护必须收敛到共享 helper，避免后续规则漂移。
- 增加最小回归测试，覆盖：
  - skill draft 保存时的名称归一化与落盘结果；
  - skill draft 保存失败时的备份回滚语义。
- 更新 `docs/REFACTOR.md`，记录本轮已阅读模块、已落地重构点与 backlog 变化。
