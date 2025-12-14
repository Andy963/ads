## Claude/Gemini 协作支持方案

> 说明：该文档为方案记录；当前实现已落地并以 `Codex` 为主管，协作调度入口为 `src/agents/hub.ts` 的 `runCollaborativeTurn()`。

### 目标
在保持 Codex 作为主导代理的前提下，引入可选的 Claude Code（后续再扩展 Gemini 等）能力，使其可以被 Codex 自动或手动调用来处理特定任务（如前端/UI 生成、长文本分析等）。

### 当前进展
- ✅ Stage 0：环境变量及配置占位（`ENABLE_CLAUDE_AGENT`、`CLAUDE_*`）已落地
- ✅ Stage 1：`AgentAdapter` + `HybridOrchestrator` 实现，并在 CLI / Telegram 落地 `/agent` 命令
- ✅ Stage 2：Claude SDK 适配器（文本模式，禁用工具）已接入
- ✅ Stage 5：Gemini SDK 适配器（文本模式，禁用工具）已接入
- ✅ 已增加 `AgentHub`：Codex 输出协作指令块 → 自动调用 Claude/Gemini → 回灌结果给 Codex 进行整合与验收（默认最多 2 轮、每轮最多 6 个协作任务）

### 阶段划分
1. **Stage 0 – 基础梳理**
   - 盘点现有 `CodexSession`、事件流、Telegram/MCP 适配层；明确需要复用的接口与日志机制。
   - 为 `.env`/config 增加占位配置：`ENABLE_CLAUDE_AGENT`、`CLAUDE_API_KEY`、`CLAUDE_MODEL` 等，并支持 `~/.claude/{config,auth}.json` 读取默认 `claude-sonnet-4.5`。

2. **Stage 1 – 抽象 Agent 接口与协调器**
   - 定义 `AgentAdapter` 接口（`id`, `supports`, `execute`, `metadata`）。
   - 将现有 Codex 逻辑封装为 `CodexAgentAdapter`。
   - 编写 `HybridOrchestrator`：接收任务描述 → 依据策略选择代理 → 统一记录日志/错误。

3. **Stage 2 – 集成 Claude Agent SDK**
   - 安装 `@anthropic-ai/claude-agent-sdk`。
   - 实现 `ClaudeAgentAdapter`：
     - 使用 `AgentRunner` 初始化（含工作目录、工具白名单）。
     - 将 orchestrator 的请求映射为 Claude Agent 的任务描述。
     - 捕获输出/错误，包装成 `AgentResult`。
   - 在 orchestrator 中加入可配置路由策略（手动命令 `/agent claude`、任务标签、失败回退）。

4. **Stage 3 – 工具与事件联动**
   - ✅ 已采用“文本指令块”方式落地：Codex 输出 `<<<agent.claude ...>>>` / `<<<agent.gemini ...>>>` 指令块，`AgentHub` 解析后调用 `orchestrator.invokeAgent()`。
   - 🔜 若未来需要更强一致性，可再补充“原生工具调用”方式（例如把 agent delegation 抽象成工具），但当前实现已满足“Codex 主管 + 协作代理产出补丁建议”的目标。

5. **Stage 4 – 配置与可视化**
   - Telegram/MCP 中新增命令：查询可用代理、启用/停用 Claude、查看当前路由策略。
   - 日志输出标记代理来源，方便审计。

6. **Stage 5 – 扩展 Gemini（可选）**
   - 复用 `AgentAdapter` 接口编写 `GeminiAgentAdapter`（占位实现 → 真正实现）。
   - 更新 orchestrator 策略，允许多代理候选（Codex → Claude → Gemini）。

### 测试计划
- 单元测试：Orchestrator 路由/错误回退；ClaudeAdapter mock。
- 集成测试：
  - 开/关 Claude 选项；
  - 指定任务由 Claude 处理并将结果回注 Codex；
  - Codex 失败时自动切 Claude（回退逻辑）。

### 配置清单（初稿）
```env
ENABLE_CLAUDE_AGENT=true
CLAUDE_API_KEY=...
CLAUDE_MODEL=claude-3-5-sonnet-20241022
CLAUDE_WORKDIR=/tmp/claude-agent
ENABLE_GEMINI_AGENT=false # 占位
```

### 备注
- 仍由 Codex 执行文件写入/命令，Claude/Gemini 主要产出补丁或文本，确保权限收敛。
- 逐步落地：先只开放“人工触发 Claude”模式，验证稳定后再考虑自动策略。
