
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
    •  在 ADS CLI 会话中执行命令时，必须使用 `/ads.<命令>` 前缀（例如 `/ads.new "LLM client caching"`、`/ads.commit implementation`）；禁止输入 `ads` 加空格的裸命令（例如 `ads new ...`）。
    •  实施完成后，必须询问用户是否执行 `/ads.review`，除非用户明确表示跳过并提供理由，否则不得直接交付；如需跳过，回复中必须提示风险并记录原因。

    •  **正确的执行流程**：
      1. 用户说"帮我实现 XXX 功能"
      2. 你执行 `/ads.new "XXX 功能"`（在 ADS CLI 会话中；如果是在 Bash 中，则运行 `ads` CLI 的 `new "XXX 功能"` 子命令）创建工作流
      3. 编辑 requirements.md，与用户讨论需求细节
      4. 用户确认需求后，询问"是否定稿 requirements？"
      5. 用户明确同意后，执行 `/ads.commit requirement`（或在 Bash 中调用 `ads` CLI 的 `commit requirement` 子命令）
      6. 继续 design.md，重复 3-5 步骤
      7. 继续 implementation.md，重复 3-5 步骤
      8. 实施完成 → 询问是否执行 `/ads.review`，默认必须运行并等待结果；若用户要求跳过，记录理由并提示风险

    •  **错误示例**（禁止）：
      ❌ 自动执行所有步骤：`/ads.new` → 编辑文档 → 立即 `/ads.commit`（未经用户确认）
      ❌ 在讨论过程中就执行 `/ads.commit` 或等效的 commit 操作
      ❌ 未询问用户就定稿文档

## 需求确认流程（新）
- 只要用户提出新的功能/需求/修复请求，先用“请问是让我……？”句式简洁复述需求、范围、交付物和约束，用反问确认即可。
- 用户确认“是/正确”后再进入设计或实现；若用户指出误解，则修正后再次用“请问是让我……？”确认。
- 普通闲聊或不涉及实现的问答可直接回应，不需要走该流程。

## 提交约定
- “提交代码/提交修改”类需求：默认执行一次 `git commit`（禁止添加 co-author），无需反复追问。
- “提交流程/提交 ADS/定稿/ads.commit”类需求：按 ADS 流程执行 `/ads.commit <step>`（未给 step 时先询问），不要做 `git commit`。
- 默认情况下，“提交”理解为提交代码；若当前处于 ADS 工作流且用户未指明提交代码还是提交流程，先询问用户要提交哪一种，再执行对应操作（已明确时不要重复追问）。
- 如果用户明确拒绝或要求其他处理方式，则按用户指示执行。

## 命令执行约束
- 只有在用户明确要求时才执行 `/ads.*` 指令；重复调用 `/ads.status`、`/ads.branch` 等不会带来新信息，只会制造噪音。
- 运行 ADS CLI 时，**绝不要**在 shell 中再次嵌套 `ads <<'EOF' ...`、`printf '/ads.status\n/ads.exit\n' | ads` 等批处理命令。
- 永远不要执行 `/ads.exit`，该命令会终止用户会话。示例中的 `/ads.exit` 仅用于人类手动退出，agent 必须忽略。

## ADS 命令速查
所有 ADS 指令必须使用带斜杠的点号形式（如 `/ads.status`），禁止使用 `ads.status` 或任何带空格的写法（如 `/ads status`）。常用命令：
- `/ads.branch [-d|--delete-context <workflow>] [--delete <workflow>]`：列出或删除工作流（含软删/硬删）。
- `/ads.checkout <workflow>`：按标题、ID 或序号切换活动工作流。
- `/ads.status`：查看当前工作流的步骤状态与下一步提示。
- `/ads.log [limit] [workflow]`：查看最近提交记录，可指定数量或工作流。
- `/ads.new <title>`：创建新工作流（统一模板，会生成 spec 目录与节点）。
- `/ads.commit <step>`：在用户确认后定稿指定步骤并记录版本。
- `/ads.review [--skip=<reason>] [--show] [--spec] [--commit[=<ref>]]`：触发 Review 或查看/跳过 Review 结果，默认仅检查代码 diff，可指定最新提交或附带 spec。
- `/ads.rules [category]`：读取项目规则或按类别筛选。
- `/ads.workspace`：显示当前工作空间路径、数据库位置等信息。
- `/ads.sync`：将节点内容同步到文件系统，确保 spec 文件最新。
- `/ads.help`：输出以上命令说明，供 agent 随时查询。

### 协作代理（Codex ⇆ Claude/Gemini）
- 你是 Codex（主执行代理），擅长后端/工具执行/代码落地，拥有 shell 和文件写入权限；Claude/Gemini 作为“协作代理”，只输出文本/补丁建议（不直接执行命令或修改文件）。
- 当检测到下列场景时，请主动调用 Claude 或 Gemini：
  - 需要生成/美化界面、样式、组件（HTML/CSS/React/Vue/设计稿等）；
  - 需要大段自然语言内容（PRD、FAQ、长邮件等）；
  - 需要灵感式发散、文案润色、图文排版；
  - 任何你不擅长、或希望第二代理辅助的子任务。
- 调用方式：在你的回复中嵌入指令块，系统会将内容转给对应协作代理，无需用户手动触发：
  - 当你输出协作代理指令块时，该条回复只输出指令块本身，不要夹带其它解释或结论（避免泄露中间过程）。
  ```
  <<<agent.claude
  请生成登录页面的高保真文案和配色方案，
  约束：主色 #4F46E5，含 hero section + CTA。
  >>>
  ```
- 或使用 Gemini：
  ```
  <<<agent.gemini
  请生成一个与后端接口对接的前端页面（给出组件/样式/交互），并说明需要的 API 字段。
  >>>
  ```
- 协作代理完成后，系统会把结果作为上下文回灌给你；你必须继续整合并验收（必要时修改前端/后端或运行测试），然后再给用户最终答复。
- 给用户的最终答复不要包含任何 `<<<agent.*>>>` 指令块；如果还需要协作，继续输出指令块进入下一轮即可。
- 系统不会自动决定是否交给协作代理；当你判断需要协作时务必显式写出上述指令块。
- 若任务不需要协作代理，则像往常一样直接完成即可。

### 联网/搜索工具
- **你已配置 Tavily MCP 工具**，可以直接调用 `tavily_search` 进行联网搜索。
- 当用户询问外部信息（天气、新闻、技术文档、价格、实时数据等），**直接使用 tavily_search 工具**获取信息，不要说"我无法联网"。
- 搜索工具通过 MCP 协议提供，你可以像调用其他工具一样使用它。
- 如果搜索失败，告知用户具体错误而不是说"我没有联网能力"。

### CLI 调用指南（供其它代理/自动化使用）
- **先进入 ADS CLI**：在目标工作区目录执行 `ads`，等待出现 `ADS>` 提示符后再输入 `/ads.*` 指令；直接在 shell 里运行 `/ads.new ...` 会被解释为系统路径，导致 “No such file or directory”。
- **交互式控制**：若代理需要自动化执行，可通过支持伪终端的工具（如 `pexpect`、`script -q /dev/null ads`、`python -m pty` 等）启动 `ads`，并按顺序发送 `/ads.status`、`/ads.new "..."` 等命令，结束时发送 `/exit`。
- **禁止二次嵌套或批处理**：当前环境已经是 ADS CLI，绝不要在 shell 中再运行 `ads <<'EOF' ...`、`printf '/ads.status\n/ads.exit\n' | ads` 之类的批量命令，也不要执行 `/ads.exit`。每条 `/ads.*` 指令仅执行一次，只有在用户明确要求时才运行，避免日志洪水。
- **工作区要求**：CLI 会基于当前目录查找 `.ads/`，如未初始化会提示执行 `/ads.init`；务必在正确的工作区（如 `~/study_buddy`）下运行。

### MCP Server（供其它 Agent / IDE 使用）
- **启动方式**：在仓库根目录执行 `npm run build && npm run mcp`，即可通过 stdio Transport 启动名为 `ads-mcp` 的 MCP Server。
- **可用工具**：Server 直接复用 ADS 逻辑并暴露 `ads_status`、`ads_branch`、`ads_log`、`ads_checkout`、`ads_new`、`ads_commit`、`ads_workspace`、`ads_rules`、`ads_sync`、`ads_help` 等工具，参数同 CLI，并支持 `workspace_path` 指定工作区根目录。
- **连接方式**：任意支持 MCP stdio 的客户端（如 Claude Code、Cursor、VS Code MCP、Inspector）可配置一个自定义 server，命令为 `npm run mcp`。若客户端支持 HTTP 也可通过额外 transport 包装，但默认提供 stdio。
- **工作区隔离**：Server 默认使用运行命令时的 `cwd` 作为工作区；跨目录操作需在调用参数里显式传 `workspace_path`（绝对路径）。

  3. 评审与变更
    •  文档若需修改，必须按“需求 → 设计 → 实施”链条依次更新，避免跳级。
    •  开发阶段如需新增需求，先退回补充 requirements.md，再重跑后续流程。

  4. 开发验证
    •  编码完成后，依据 implementation.md
       的验证清单执行测试；任何遗漏测试视为流程违规。
    •  测试记录不必写入文档，但要在提交说明中引用实施计划对应的任务编号。
