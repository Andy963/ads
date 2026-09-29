# ADR 0033: Isolate bounded Reviewer inspection

## Status
Accepted

## Context
Reviewer 需要主动检查关联源码，但通用 Agent 会话可能暴露 shell、写入或其他工具，不能仅靠提示词保证只读。

## Decision
Reviewer 使用独立 HTTP completion 循环，只注册 `read_file_range`、`search_code`、`list_dir`。模型、推理强度与角色指令每次从数据库角色配置读取；模型连接按任务所有者解析，不复用 Developer 会话。

工具读取已捕获的精确 Git commit，而不是可变工作区。宿主通过固定参数的 Git 子进程读取 regular blobs，不执行 shell、textconv 或子模块，不暴露任意命令。路径穿越、符号链接及常见凭据文件被拒绝；这不是通用操作系统沙箱。

默认允许五个工具回合，每回合至多四个串行调用；回合或输出预算耗尽后移除工具，要求最终 JSON。取消与超时传播至 HTTP 和 Git 子进程，结束时释放消息与索引缓存，不创建临时工作区或持久会话。错误沿既有有界返工流程处理。

## Consequences
审查证据与提交保持一致，不受工作区变化或符号链接替换影响。未提交文件、被排除文件及超限内容不能检查，模型必须明确证据缺口。

Reviewer 配置必须具有可供现有 HTTP completion 客户端使用的模型连接与凭据；仅有 Codex CLI 登录不保证可用。不回退到带任意工具的 Agent 会话。Developer 仍使用所选运行时，本决策不改变队列串行执行和合并收尾规则。
