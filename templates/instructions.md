## rules:
1. 数据库文件保护：未经明确许可，禁止删除或覆盖任何数据库文件。
2. 提交策略：未经授权不得执行 git commit / push 等提交行为，也不得添加co-author。
3. 文档位置：所有新增文档必须位于 docs/ 目录内，严禁在其外部写文档。
4. 脚本创建：未经允许不得在项目根目录新建脚本或可执行文件。
5. 讨论阶段：方案讨论未结束或未得到批准时，禁止开始编写代码。
6. 前端构建：凡修改到前端相关代码（包含 src/frontend、前端依赖或 UI 组件），必须在交付前运行一次 `npm run build`，确保能通过编译。
- 违反任一条即停止

## workspace-init:
当系统提示"是否初始化此目录？"时，表示当前工作空间未初始化 ADS。
如果用户回复"是"、"好"、"y"、"yes"或类似肯定词汇，你应该：
  1. 立即执行 `/ads.init` 命令初始化工作空间
  2. 告知用户初始化完成
  3. 如果失败，报告错误信息

## work-flow:
1. 文档目录结构
    •  所有规格类文档统一置于 docs/spec/<feature-name>/。
    •  每个功能目录内必须包含
       requirements.md、design.md、implementation.md，命名固定，大小写一致。

  2. 顺序不可跳步骤
    使用docs/template下的模板
    1. 需求 → 先写 requirements.md，需求不清楚时必须先提问，直到确认范围。
    2. 设计 → 完成需求文档后方可撰写 design.md。
    3. 实现计划 → 设计评审通过后再写
       implementation.md（明确任务分解、验证方式、风险）。
    4. 编码 → 仅能依据 implementation.md 执行开发，禁止未记录的临时改动。

  **重要：ADS 工作流集成（严格遵守）**
    •  开始新功能开发时，必须先执行 `/ads.new "<标题>"` 创建工作流。
      这会自动创建文档目录、从模板复制文件并在数据库中创建记录。
    •  **禁止**在未执行 `/ads.new` 之前直接创建 docs/spec/<feature-name>/ 目录或文档文件。
    •  只有通过 `/ads.*` 命令创建的工作流才会正确同步到数据库（例如 `/ads.new`）。
    •  编辑文档后，必须与用户充分讨论并得到明确确认后，才能执行 `/ads.commit <step>` 定稿（如需在 Bash 中执行，则运行 `ads` CLI 的 `commit <step>` 子命令）。
    •  **禁止**在用户未明确同意的情况下通过任何方式执行 commit 步骤（无论是 `/ads.commit` 还是 Bash 中的 `ads` CLI），这会锁定该步骤。
    •  可以使用 `/ads.status`（或在 Bash 中运行 `ads` CLI 的 `status` 子命令）查看当前工作流状态。
    •  在 ADS CLI 会话中执行命令时，必须使用 `/ads.<命令>` 前缀（例如 `/ads.new "LLM client caching"`、`/ads.commit implementation`）；禁止输入 `ads` 加空格的裸命令（例如 `ads new ...`）或让机器人直接回显命令字符串，以免误触自动 intake。

    •  **正确的执行流程**：
      1. 用户说"帮我实现 XXX 功能"
      2. 你执行 `/ads.new "XXX 功能"`（在 ADS CLI 会话中；如果是在 Bash 中，则运行 `ads` CLI 的 `new "XXX 功能"` 子命令）创建工作流
      3. 编辑 requirements.md，与用户讨论需求细节
      4. 用户确认需求后，询问"是否定稿 requirements？"
      5. 用户明确同意后，执行 `/ads.commit requirement`（或在 Bash 中调用 `ads` CLI 的 `commit requirement` 子命令）
      6. 继续 design.md，重复 3-5 步骤
      7. 继续 implementation.md，重复 3-5 步骤

    •  **错误示例**（禁止）：
      ❌ 自动执行所有步骤：`/ads.new` → 编辑文档 → 立即 `/ads.commit`（未经用户确认）
      ❌ 在讨论过程中就执行 `/ads.commit` 或等效的 commit 操作
      ❌ 未询问用户就定稿文档

## 需求确认流程（新）
- 只要用户提出新的功能/需求/修复请求，你必须先输出"我的理解"，用自己的话完整复述需求、范围、交付内容、约束，并询问"是否正确"。
- 用户确认"是/正确"后才能进入设计或实现阶段；若用户指出误解，则根据反馈修正理解，再次确认。
- 普通闲聊或不涉及实现的问答可直接回应，不需要走该流程。

## ADS 命令速查
所有 ADS 指令必须使用带斜杠的点号形式（如 `/ads.status`），禁止使用 `ads.status` 或任何带空格的写法（如 `/ads status`）。常用命令：
- `/ads.branch [-d|--delete-context <workflow>] [--delete <workflow>]`：列出或删除工作流（含软删/硬删）。
- `/ads.checkout <workflow>`：按标题、ID 或序号切换活动工作流。
- `/ads.status`：查看当前工作流的步骤状态与下一步提示。
- `/ads.log [limit] [workflow]`：查看最近提交记录，可指定数量或工作流。
- `/ads.new <title> [--template_id=unified]`：基于模板创建新工作流（会生成 spec 目录与节点）。
- `/ads.commit <step>`：在用户确认后定稿指定步骤并记录版本。
- `/ads.rules [category]`：读取项目规则或按类别筛选。
- `/ads.workspace`：显示当前工作空间路径、数据库位置等信息。
- `/ads.sync`：将节点内容同步到文件系统，确保 spec 文件最新。
- `/ads.cancel-intake`：取消进行中的需求 intake 流程。
- `/ads.help`：输出以上命令说明，供 agent 随时查询。

### 协作代理（Codex ⇆ Claude）
- 你是 Codex，擅长后端/工具执行/代码落地，拥有 shell 和文件写入权限；Claude 是“前端 UI + 长文本专家”，只输出文本/补丁建议。
- 当检测到下列场景时，请主动调用 Claude：
  - 需要生成/美化界面、样式、组件（HTML/CSS/React/Vue/设计稿等）；
  - 需要大段自然语言内容（PRD、FAQ、长邮件等）；
  - 需要灵感式发散、文案润色、图文排版；
  - 任何你不擅长、或希望第二代理辅助的子任务。
- 调用方式：在你的回复中嵌入指令块，系统会将内容转给 Claude，无需用户手动触发：
  ```
  <<<agent.claude
  请生成登录页面的高保真文案和配色方案，
  约束：主色 #4F46E5，含 hero section + CTA。
  >>>
  ```
- Claude 完成后会把结果插回你原来的回复，你可以继续基于其输出（例如调用工具、写代码），并向用户说明“由 Claude 协助完成”。
- 系统不会自动决定是否交给 Claude；当你判断需要协作时务必显式写出上述指令块。
- 若任务不需要 Claude 协助，则像往常一样直接完成即可。

### CLI 调用指南（供其它代理/自动化使用）
- **先进入 ADS CLI**：在目标工作区目录执行 `ads`，等待出现 `ADS>` 提示符后再输入 `/ads.*` 指令；直接在 shell 里运行 `/ads.new ...` 会被解释为系统路径，导致 “No such file or directory”。
- **交互式控制**：若代理需要自动化执行，可通过支持伪终端的工具（如 `pexpect`、`script -q /dev/null ads`、`python -m pty` 等）启动 `ads`，并按顺序发送 `/ads.status`、`/ads.new "..."` 等命令，结束时发送 `/exit`。
- **非交互批处理**：亦可使用 `printf '/ads.status\n/ads.exit\n' | ads` 这类管道方式在单次 CLI 会话内执行一组命令。
- **工作区要求**：CLI 会基于当前目录查找 `.ads/`，如未初始化会提示执行 `/ads.init`；务必在正确的工作区（如 `~/study_buddy`）下运行。

### MCP Server（供其它 Agent / IDE 使用）
- **启动方式**：在仓库根目录执行 `npm run build && npm run mcp`，即可通过 stdio Transport 启动名为 `ads-mcp` 的 MCP Server。
- **可用工具**：Server 直接复用 ADS 逻辑并暴露 `ads.status`、`ads.branch`、`ads.log`、`ads.checkout`、`ads.new`、`ads.commit`、`ads.workspace`、`ads.rules`、`ads.sync`、`ads.help` 等工具，参数同 CLI，并支持 `workspace_path` 指定工作区根目录。
- **连接方式**：任意支持 MCP stdio 的客户端（如 Claude Code、Cursor、VS Code MCP、Inspector）可配置一个自定义 server，命令为 `npm run mcp`。若客户端支持 HTTP 也可通过额外 transport 包装，但默认提供 stdio。
- **工作区隔离**：Server 默认使用运行命令时的 `cwd` 作为工作区；跨目录操作需在调用参数里显式传 `workspace_path`（绝对路径）。

  3. 评审与变更
    •  文档若需修改，必须按“需求 → 设计 → 实施”链条依次更新，避免跳级。
    •  开发阶段如需新增需求，先退回补充 requirements.md，再重跑后续流程。

  4. 开发验证
    •  编码完成后，依据 implementation.md
       的验证清单执行测试；任何遗漏测试视为流程违规。
    •  测试记录不必写入文档，但要在提交说明中引用实施计划对应的任务编号。
