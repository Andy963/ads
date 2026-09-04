# ADR 0004: 退役全局规则提示注入并固化机器安全拦截

## Status
Accepted

## Context

ADS 曾把流程性说明、机器安全约束和数据库规则管理放在同一套 `global_rules` 机制中。系统提示每轮读取并编译规则，Web 控制台和 API 还允许修改这些规则。这个设计会扩大 prompt、让模型受到不必要的流程性约束，并使本应不可协商的主机安全依赖可变数据库状态。

当前流程知识已经由按需 skills、仓库 `AGENTS.md` 和用户偏好提供；机器安全需要在执行边界由确定性代码保证。

## Decision

1. `SystemPromptManager` 不再读取 `rules.md`、规则服务或 `global_rules` 表，不再生成或注入 `<global_rules>`。
2. 删除 Global Rules Web 组件、相关 API 路由及其运行时 wiring。
3. 在共享的安全中间件中保留不可变命令匹配器，拦截 ADS 自终止命令以及数据库删除、覆盖和写入命令。
4. Codex App Server 的 command item 启动拦截、Web/TG 事件安全评估复用同一纯代码判断，不读取或写入规则数据库。
5. 保留既有数据库表和 migration 作为惰性遗留结构，不执行数据删除或 destructive migration。

## Consequences

### Positive

- 系统提示不再携带全局规则噪声，也不会因规则数据库状态变化而改变。
- 机器安全行为独立于模型提示和数据库，Web、Telegram 与 Codex 使用同一套判断。
- Rules UI/API 的维护面和可变治理路径被移除。

### Trade-offs

- 历史 `global_rules` 数据不会再通过 ADS 管理或执行；后续清理需要单独的迁移和明确授权。
- 历史会话中的 `<global_rules>` 文本仍由 prompt preview 清洗器兼容处理，但这不是新的注入路径。
