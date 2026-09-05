# ADR 0007: 对齐 Codex 标准技能目录与存储发现机制

## 背景与现状

此前 ADS 在演进早期为了兼顾多 Agent 抽象（尝试在 Codex、Claude、Droid 等之间做中立目录），定义了自定义的 `.agent/skills/` 规范：
- 共享/状态技能：`$ADS_STATE_DIR/.agent/skills/<name>/`
- 全局技能：`~/.agent/skills/<name>/`
- 工作区技能：`<workspace>/.agent/skills/<name>/`

然而，随着 ADS 全面收敛至统一的 Codex App-Server 架构（Issue #133），Codex 原生技能标准为：
- 全局技能：`$CODEX_HOME/skills/<name>/`（默认 `~/.codex/skills/<name>/`）

此前的分立导致：
1. 目录割裂：用户在原生 Codex CLI 安装的官方/社区技能与 ADS 内沉淀的技能互相隔离，无法共享。
2. 重复发现：ADS 维持了针对 `.agent/skills` 的发现与自动沉淀逻辑，阻碍了跨会话与命令行统一。

## 决策内容

1. **全面对齐标准路径**：
   - 全局技能统一存储并发现于 `$CODEX_HOME/skills/<name>/`（默认 `~/.codex/skills/<name>/`）。
   - ADS 统一仅支持全局技能库与内部内置技能，不维护工作区级别的技能副本或覆盖；优先级确定为：全局技能（`global`） > 内置技能（`builtin`）。
   - 保持内置 ADS 技能于内部目录 `server/skills/builtin/`（source 为 `builtin`）。
2. **废弃 `.agent/skills`**：
   - 代码库中的 loader、creator、registryMetadata、commandRouter、系统提示词模板全面清除对 `.agent/skills` 的依赖，`SkillMetadata` 的 source 字段严格收敛为 `global | builtin`。
3. **平滑非破坏性与原子故障安全迁移**：
   - 运行时 `discoverSkills()` 及 CLI `npm run skills:migrate` 调用统一迁移模块 `server/skills/migration.ts`。
   - 将 `$ADS_STATE_DIR/.agent/skills/` 下的存量技能非破坏性复制至目标 `$CODEX_HOME/skills/`；先拷贝至临时 staging 目录再原子重命名，复制失败或中断绝不残留半同步目录；若目标已存在同名技能则跳过，严禁覆盖现有文件且绝不删除源文件。
4. **持久化对齐**：
   - 模型通过 `<skill_save>` 块沉淀技能时，默认持久化至全局 `$CODEX_HOME/skills/<name>/SKILL.md`，即时对 ADS 与原生 Codex 可用。

## 影响与验证

- 现有技能（如 `advisor-issue-flow`, `worker-pr-lifecycle` 等）自动迁移并在全局被发现。
   - 单元测试覆盖全局发现、覆盖优先级、非破坏性迁移及防覆盖测试。
