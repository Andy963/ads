# Project-wide Refactor Pass 40 - Skill Creator Validation Helpers

## Approach

- 在 `server/skills/creator.ts` 内抽取两个内部 helper：
  - `normalizeValidatedSkillName()`：统一 name 归一化、空值、长度与 hyphen-case 校验；
  - `resolveSkillDirectory()`：统一 workspace root、skills root、skill dir 解析与路径逃逸防护。
- `initSkill()` 与 `saveSkillDraftFromBlock()` 改为调用共享 helper，删除重复分支。
- 在 `tests/skills/creator.test.ts` 增加针对 `saveSkillDraftFromBlock()` 的直接回归测试，锁定 shared helper 覆盖到的行为。

## Tradeoffs

- 本轮只做 `creator.ts` 内部重复逻辑收敛，不处理 `server/skills/builtin/skill-creator/scripts/init-skill.ts` 的跨文件复用，避免把本轮重构扩大成 CLI/script 契约改造。
- helper 继续保持文件内私有，先优化维护成本，不额外扩大公共 API 面积。
