# Global Rules Architecture

> 状态：已退役（Issue #134）。本文记录兼容边界，避免将历史实现误认为当前运行时契约。

## 当前决策

- `SystemPromptManager` 不再读取或编译 `templates/rules.md`，也不会向任何 agent 注入 `<global_rules>`。
- Web 控制台不再提供 Global Rules 管理界面，服务端也不再注册 `/api/global-rules` 路由。
- ADS 自身进程保护和数据库文件保护由 `server/middleware/builtin/globalRulesMiddleware.ts` 中的不可变正则规则执行。
- Web 与 Telegram 的事件桥接可以复用同一纯代码安全判断，但不读取规则数据库。

## 数据兼容

`global_rules`、审计表以及相关 migration 暂不删除或重写。这样可以保留已有 state.db 的兼容性；它们不再被正常请求路径读取、写入、种子化或注入 prompt。后续若要清理历史数据，必须另行评估并获得明确授权。

## 历史实现

此前的数据库规则服务同时承担 prose prompt injection、规则管理 API、前端 modal 和命令评估。该耦合会扩大 prompt、造成模型执行阻塞，并使安全行为依赖可变数据库状态。Issue #134 将这两类职责拆开：流程知识由按需 skills 与仓库文档提供，机器安全由纯代码拦截器保证。

## 验证边界

- 系统提示测试确认历史 `rules.md` 内容不会进入 injection。
- 中间件测试覆盖 ADS 服务自终止命令、数据库删除/覆盖命令，以及普通只读命令。
- 历史 prompt 预览仍可清洗旧会话中已经持久化的 `<global_rules>` 文本；这不是新的注入路径。
