# Project-wide Refactor Pass 40 - Skill Creator Validation Helpers

## Steps

1. 为 `server/skills/creator.ts` 抽取共享的 skill name 校验与 skill dir 解析 helper。
2. 更新 `initSkill()` / `saveSkillDraftFromBlock()` 使用共享 helper，保持外部行为不变。
3. 扩展 `tests/skills/creator.test.ts`，覆盖 draft 保存成功与失败回滚语义。
4. 更新 `docs/REFACTOR.md`，同步 reviewed/touched、backlog 与 spec pass 记录。
