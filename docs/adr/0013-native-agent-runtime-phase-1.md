# ADR 0013: Introduce the Opt-In Native Agent Runtime

## Status

Accepted

## Context

ADS 当前默认通过 Codex app-server daemon 执行 agent turn。这个路径继续承担现有生产行为，但它把 provider endpoint、模型切换和工具执行绑定在外部 daemon 协议上，无法验证原生 TypeScript runtime。

当前模型配置表只保存模型元数据和非敏感 JSON；API key 由 `UpstreamCredentialStore` 加密保存。因此 native runtime 不能从 `model_configs.config_json` 读取凭据，也不能为了支持多 provider 而绕过现有凭据边界。

## Decision

本阶段新增 `server/runtime/` 和 `NativeAgentAdapter`，通过 `ADS_AGENT_RUNTIME=native` 选择；未设置该变量时仍构造 `CodexAppServerAdapter`。native adapter 继续使用现有 `AgentAdapter`、`AgentEvent`、WebSocket 和 middleware 契约，因此前端不需要新的运行时协议。

provider 请求采用 OpenAI-compatible `/chat/completions` SSE。每个 turn 根据模型配置和认证用户解析 endpoint、model、provider 与加密 credential profile；model JSON 只允许保存 `credentialProfile` 和受限请求参数。endpoint 必须与加密 profile 的规范化 endpoint 一致，避免把一个 provider 的 key 发送到另一个 endpoint。

本阶段提供四个受限工具：`exec_command`、`read_file`、`search` 和 `apply_patch`。文件工具限制在 workspace 及其真实路径内，命令工具在 native runtime 中运行于 project-scoped sandbox，简单命令仍使用 `shell: false`，并保留超时、输出上限、allowlist 和现有 middleware 安全规则；命令环境过滤明显的 secret-shaped variables。patch 在写入前完成全部 context 校验，并在写入失败时尝试回滚。

native 事件桥接为现有 `AgentEvent`：文本使用累计 snapshot，工具、命令、文件变更、turn completion 和错误使用现有 thread item 形状。工具执行器把参数校验、路径解析、命令退出失败和 patch context 失败编码为 tool result，交还模型进行下一轮自愈；上游传输、取消和 runtime 构造失败仍然结束 turn。工具循环达到最大轮数后返回正常的 continuation notice，不把配置上限误报成 turn failure。

对于不包含 Shell 元字符的命令，native runtime 继续使用 direct executable 加参数数组。包含管道、重定向或复合操作符的命令进入受控 Shell 路径：Linux 上通过 `bubblewrap` 创建 project-scoped mount namespace，只把 workspace 以可写方式挂载，把必要的系统运行目录以只读方式挂载，并隐藏 host home、临时目录和其他根文件；找不到沙箱能力时 fail closed。命令仍经过全局安全规则、git push 拦截、超时、输出上限、取消和可选 executable allowlist。Shell 路径不改变模型凭据边界，命令环境同样过滤 secret-shaped variables。

`reasoning_effort` 不是 OpenAI-compatible provider 的通用字段。native model resolver 只有在模型配置显式声明能力、配置了非空 reasoning effort 列表，或模型 ID 能安全匹配已知 reasoning family 时才把该字段发送给上游；默认和未知模型省略该字段，以避免非 reasoning 模型因 unsupported parameter 返回 400。

## Consequences

正面影响：可以在不改变 WebSocket 和 UI 的情况下测试 in-process streaming、多 endpoint credential profile 和原生工具执行；Codex app-server 仍是默认路径，native runtime 可以逐步启用。

本阶段明确不实现 immutable tape、历史事件持久化、context compaction、background job polling、非 OpenAI-compatible 协议和 Codex daemon 的移除。native conversation 只在当前 adapter 生命周期内保留；跨进程恢复仍依赖既有 history injection，后续阶段必须为 tape 和 compaction 建立独立存储，而不能把 `history_entries` 直接当作 immutable tape。
