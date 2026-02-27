# Refactor Tracker

本文件用于持续记录：已阅读/触达模块、可重构点（backlog）、尚未覆盖模块。每次重构落地请同步更新。

最后更新：2026-02-28

## Reviewed / Touched

### Backend (`src/`)

- `src/tasks/executor.ts`：更新 `responding` 流式 `delta` 合并逻辑，兼容累积/增量语义并通过 overlap 去重。
- `src/tasks/queue.ts`：重构（统一 `AbortError` 创建/识别与错误信息提取，降低跨模块中断处理分叉）。
- `src/utils/commandRunner.ts`：重构（抽取子进程 lifecycle：timeout/abort/cleanup，减少 pipe/file 两条路径重复逻辑，并补齐测试覆盖）。
- `src/utils/commandRunner.ts`：重构（抽取并导出 `assertCommandAllowed()` / `isGitPushCommand()`，统一 host/bootstrap 命令 allowlist 与 `git push` 拦截逻辑来源）。
- `src/utils/abort.ts`：新增（统一 `AbortError` 创建/识别：`createAbortError()` / `isAbortError()`，用于跨模块中断语义收敛）。
- `src/utils/activityTracker.ts`：重构（将 `ingestToolInvoke()` 的工具分支拆分为结构化私有 handler，降低复杂度并保持行为不变）。
- `src/utils/logger.ts`：阅读（风格可统一，但当前不作为优先项）。
- `src/utils/flags.ts` / `src/utils/env.ts` / `src/utils/error.ts` / `src/utils/text.ts`：阅读（通用工具）。
- `src/utils/streamingText.ts`：新增（流式文本合并工具：`mergeStreamingText()`）。
- `src/utils/inputText.ts`：重构（`extractTextFromInput()` 引入 `{ trim }` 显式语义开关，默认不 trim；用于 Claude/Gemini adapters prompt 构造去重并保持字节级一致）。
- `src/utils/terminalText.ts`：移除（未被引用的 terminal text width utilities：`stringDisplayWidth()` / `truncateToWidth()`）。
- `src/state/database.ts`：阅读（状态库 schema 初始化）。
- `src/storage/migrations.ts`：阅读（迁移列表与末尾示例注释）。
- `src/bootstrap/bootstrapLoop.ts` / `src/bootstrap/worktree.ts` / `src/bootstrap/agentRunner.ts` / `src/bootstrap/review/reviewerRunner.ts`：重构（统一 `AbortError` 语义与实现，减少重复代码）。
- `src/bootstrap/artifacts.ts`：重构（移除本地 `safeStringify()` 重复实现，复用 `src/utils/json.ts`）。
- `src/bootstrap/commandRunner.ts`：重构（删除本地 allowlist / `git push` 校验重复实现，复用 `src/utils/commandRunner.ts` 的共享 helper）。
- `src/agents/hub.ts` / `src/agents/hub/delegations.ts` / `src/agents/tasks/taskCoordinator.ts` / `src/agents/tasks/taskCoordinator/helpers.ts` / `src/agents/adapters/{codex,claude,gemini}CliAdapter.ts`：重构（统一 `AbortError` 语义与实现，减少重复代码）。
- `src/agents/orchestrator.ts`：重构（抽取 `send()` / `invokeAgent()` 共享发送管线，收敛 preference-only 短路与响应后缀拼装逻辑，保持行为不变）。
- `src/agents/adapters/{claude,gemini}CliAdapter.ts`：重构（移除重复 `inputToString()`，复用 `src/utils/inputText.ts` 的 `extractTextFromInput({ trim: false })`，保持 prompt 字节级一致）。
- `src/agents/tasks/verificationRunner.ts`：重构（flag 解析复用 `parseBooleanFlag()`；ui smoke managed service spawn 复用 `assertCommandAllowed()`；readyUrl 失败时补充 spawn error 提示并尽快失败）。
- `src/agents/adapters/claudeCliAdapter.ts` / `src/agents/cli/claudeStreamParser.ts`：修复（Claude CLI 首次请求不再传 `--session-id`；从 `system.init` 捕获 `session_id` 并在后续 `send()` 通过 `--resume` 复用同一会话，避免 `Session ID ... is already in use`）。
- `src/agents/cli/cliRunner.ts`：重构（抽取 spawn wait / ENOENT hint / JSONL 单行解析 / abort handler 私有 helper，减少 pipe/file 路径重复逻辑并保持行为不变）。
- `src/agents/cli/{claudeStreamParser.ts,geminiStreamParser.ts,streamParserUtils.ts}`：重构（抽取共享 `ToolKind`/`TrackedTool` 与 `asRecord()`/`extractStringField()`/`attachCliPayload()`/`mapEvent()`，减少重复并保持行为不变）。
- `src/agents/cli/stripAnsi.ts`：阅读（ANSI 清理工具）。
- `src/agents/tasks/taskStore.ts`：重构（复用 `safeParseJsonFromUnknown()` 并抽取 row 字段转换 helper，减少 `toTaskRow()` 重复样板并保持容错语义不变）。
- `src/codex/errors.ts`：更新（识别 `Session ID ... is already in use` 并分类为 `session_in_use`，给出可操作的用户提示）。
- `src/codex/events.ts`：重构（`reasoning`/`todo_list` 事件映射去重，整理 `agent_message` 分支可读性，保持行为不变）。
- `src/attachments/{images.ts,store.ts,types.ts}`：阅读（图片元信息探测 + 附件去重存储与归属管理）。
- `src/workspace/detector.ts` / `src/workspace/adsPaths.ts` / `src/workspace/service.ts`：阅读（工作空间探测与集中式 state 目录）。
- `src/workspace/rulesService.ts`：重构（规则违规检测做大小写不敏感匹配，降低误漏判）。
- `src/workspace/detector.ts`：重构（新增 `resolveWorkspaceRoot()`，统一将外部传入的 `workspace_path` 归一到 workspace root，避免子目录传参导致 state/db/spec 漂移）。
- `src/workflow/{formatter.ts,serviceCommitLog.ts,serviceSteps.ts,serviceSummary.ts,serviceWorkflows.ts,templateService.ts}`：重构（`workspace_path` 通过 `resolveWorkspaceRoot()` 归一到 workspace root，行为保持不变）。
- `src/graph/service.ts`：重构（`workspace_path` 通过 `detectWorkspaceFrom()` 归一到 workspace root，避免子目录传参导致 graph 操作落错 workspace）。
- `src/graph/autoWorkflow.ts`：重构（整理 `onNodeFinalized()` 分支并抽取“查找已有 next node” helper，减少重复查询并保持工作流语义不变）。
- `src/skills/loader.ts`：阅读（skill 发现与缓存逻辑）。
- `src/systemPrompt/manager.ts`：阅读（system prompt reinjection、workspace fallback、skill/soul 注入与缓存策略）。
- `src/web/utils.ts`：重构（`deriveWebUserId()` 扩展到 48-bit 熵，并保留 legacy 32-bit 派生用于迁移）。
- `src/web/server/ws/server.ts`：重构（WebSocket 建连时 best-effort 迁移 legacy `userId` 的 thread/cwd 状态，尽量保持“续聊/目录”体验不变）。
- `src/web/auth/cookies.ts`：重构（`serializeCookie()` 不再默认添加 `Secure`，避免未来 HTTP 场景误用）。
- `src/web/auth/sessions.ts`：重构（`resolveSessionSlidingEnabled()` 复用 `parseBooleanFlag()`，并抽取 `normalizeSessionTtlSeconds()` 收敛 create/lookup/refresh 的 TTL 下限逻辑）。
- `src/web/api/taskRun.ts` / `src/web/server/api/handler.ts`：阅读（web API 路由匹配/鉴权/分发顺序）。
- `src/web/server/api/routes/attachments.ts`：阅读（图片附件上传与 raw 读取接口）。
- `src/web/server/api/routes/tasks/{shared.ts,tasks.ts,tasks/taskById.ts,tasks/chat.ts}`：重构（抽取并复用 task route 共享 helper：`resolveTaskContextOrSendBadRequest()` / `readJsonBodyOrSendBadRequest()`；`chat` 路由改用 `safeParse` 返回显式 `400`，避免异常冒泡）。
- `src/web/server/api/routes/schedules.ts`：重构（抽取并复用 body 读取/compile 错误处理/instruction 归一/spec 激活态组装 helper，减少 `POST/PATCH` 分支重复逻辑并保持响应语义不变）。
- `src/web/server/httpServer.ts`：重构（提取 content-type 解析；gzip/non-gzip 统一 `pipeline` 写入并对齐错误清理）。
- `src/web/server/ws/{taskResume.ts,handleTaskResume.ts}`：阅读（恢复上下文选择、thread resume 验证与 fallback transcript 恢复链路）。
- `src/web/taskNotifications/{store.ts,telegramNotifier.ts}`：重构（收敛终态状态来源与数值归一化 helper；通知发送路径复用统一终态判定并按时区缓存 timestamp formatter，减少重复构造开销）。
- `src/web/taskNotifications/{telegramConfig.ts,schema.ts}`：阅读（Telegram 通知配置解析与持久化 schema 约束）。
- `src/telegram/utils/threadStorage.ts`：重构（新增 `cloneRecord()`，用于迁移时保留 `updated_at` 语义）。
- `src/telegram/utils/sessionManager.ts`：重构（新增 `maybeMigrateThreadState()`，封装 thread state 迁移入口）。
- `src/telegram/utils/urlHandler.ts`：重构（`downloadUrl()` 改用 `pipeline`+size limiter，失败时清理临时文件并保留 error cause；`AbortError` 语义统一到 `createAbortError()` / `isAbortError()`）。
- `src/telegram/utils/fileHandler.ts`：重构（`Api` 改为 type-only import；`AbortError` 语义统一到 `createAbortError()` / `isAbortError()`，减少手写 name 分叉）。
- `src/telegram/utils/imageHandler.ts`：重构（`AbortError` 语义统一到 `createAbortError()` / `isAbortError()`，减少手写 name 分叉）。
- `src/telegram/utils/transcriptCorrection.ts`：重构（bool flag 解析收敛到 `src/utils/flags.ts`，删除重复实现）。
- `src/scheduler/compiler.ts` / `src/scheduler/runtime.ts` / `src/scheduler/store.ts`：重构（env flag 解析收敛到 `src/utils/flags.ts`，并重命名 sqlite boolean helper，保持行为不变）。
- `src/utils/json.ts`：重构（新增 `safeParseJsonFromUnknown()`，收敛跨模块 `safeJsonParse()`/`parseJson()` 重复实现）。
- `src/utils/json.ts`：重构（`safeStringify()` 改为 non-throwing fallback，覆盖 circular/bigint 等异常输入）。
- `src/tasks/executor.ts`：重构（改用 `safeParseJson()` 解析 `workspace_patch` artifact，删除本地重复实现）。
- `src/web/server/taskQueue/manager.ts`：重构（改用 `safeParseJson()` 解析 `changed_paths` artifact，删除本地重复实现）。
- `src/web/server/planner/taskBundleDraftStore.ts`：重构（改用 `safeParseJsonFromUnknown()` 解析 sqlite 行内 JSON 字段，删除本地重复实现）。
- `src/web/server/planner/specValidation.ts`：新增（task bundle 草稿/审批的 `specRef` 归一与目录/文件完整性校验）。
- `src/web/server/ws/handlePrompt.ts`：更新（planner 草稿写入前校验 `specRef`；auto-approve 也校验 spec 文件完整性；并在 summary 中汇总未写入原因）。
- `src/web/server/api/routes/taskBundleDrafts.ts`：更新（approve API 在执行前校验 `specRef` + spec 文件完整性，失败写入 lastError 并返回 400）。
- `src/utils/activityTracker/text.ts`：重构（`safeJsonParse()` 改为代理到 `safeParseJson()`，收敛 JSON parse 语义）。
- `src/tasks/storeImpl/normalize.ts`：重构（`parseJson()` 改为代理到 `safeParseJsonFromUnknown()`，删除本地重复实现）。
- `src/tasks/storeImpl/taskOps.ts`：修复（`reorderPendingTasks()` 对传入 ids 做 pending 集合校验，避免静默部分重排）。
- `src/tasks/storeImpl/{mappers.ts,conversationOps.ts,modelConfigOps.ts}`：重构（抽取并复用 Conversation/ModelConfig row mapper，收敛重复字段转换逻辑并保持行为不变）。
- `src/tasks/store_impl.ts`：阅读（TaskStore facade 与 purge 逻辑）。
- `src/audio/transcription.ts`：重构（一次 `transcribeAudioBuffer()` 调用内只 discovery skills 一次，并复用 lookup；临时音频文件名改用 `crypto.randomUUID()` 以降低碰撞概率）。
- `src/graph/fileManager.ts`：重构（优化 `syncAllNodes()` / `generateIndex()` 的批量路径：workflow 分组后复用 sequence/specDir，避免 per-node 重复序号计算与路径推导）。
- `src/graph/{crud,service,workflowConfig,finalizeHelper,types}.ts`：阅读（graph 模块核心数据/配置与服务层）。
- `src/memory/soul.ts`：重构（Preferences section 边界解析更直观，并补齐中间 section 场景测试覆盖）。
- `src/memory/preferenceDirectives.ts`：阅读（偏好写入指令解析）。

### Frontend (`web/`)

- `web/src/components/TaskDetail.vue`：统一中文 UI 文案，并补齐 `queued` / `paused` 的空态与占位提示。
- `web/src/api/types.ts`：阅读（`TaskStatus`/`Task` 类型）。
- `web/src/api/client.ts`：重构（统一成功响应的 JSON 解析路径，失败时提供更清晰的上下文；错误响应保持 raw body 以兼容 `formatApiError()` 的 JSON message 提取）。
- `web/src/api/ws.ts`：阅读（WebSocket 消息结构与 sessionId/chatSessionId 生成逻辑）。
- `web/src/app/chatExecute.ts`：修复（流式输出在前缀换行后仍能剥离冗余的 `$ <command>` 回显，避免 execute preview body 重复展示 command）。
- `web/src/app/projectsWs/webSocketActions.ts`：修复（`connectWsInternal()` 在 identity 校验 `await` 前先挂载 provisional WS，避免 remove project 时 `closeProjectConnections()` 关不掉“连接进行中”的 WS）。
- `web/src/app/projectsWs/projectActions.ts`：阅读（项目增删改、激活切换、目录校验与 session 切换主流程）。
- `web/src/app/projectsWs/projectActions.ts`：重构（抽取 stored/remote project normalize helper，统一字符串/时间戳清洗与默认值处理）。
- `web/src/app/projectsWs/wsMessage.ts`：重构（提取 workspace->project 同步 helper，收敛 `welcome`/`workspace` 分支重复更新逻辑，保持行为不变）。
- `web/src/app/taskBundleDrafts.ts` / `web/src/app/taskBundleDraftsState.ts`：重构（抽取并复用任务草稿列表 normalize/upsert/remove helper，统一 actions 与 WS 更新路径语义）。
- `web/src/app/taskBundleDrafts.ts`：重构（抽取 `withDraftRequest()` / `fetchTaskBundleDrafts()`，统一登录校验、busy/error 生命周期与错误字符串处理）。
- `web/src/app/tasks/reorder.ts`：重构（移除多余 type assertion；`queueOrder` 排序在异常输入下更稳定）。
- `web/src/app/{tasks.ts,tasks/localState.ts,tasks/selection.ts}`：重构（抽取 `pickNextSelectedTaskId()` 共享 helper，统一任务加载/删除后的默认选中规则）。
- `web/src/app/tasks/events.ts`：重构（改为 `switch` 分发并抽取终态事件共享收尾 helper，收敛 `completed/failed/cancelled` 重复逻辑，保持行为不变）。
- `web/src/app/tasks/events.ts`：重构（抽取 task event payload parsing helper，集中字段 sanitize/guard，减少分支内重复类型断言）。
- `web/src/components/{TaskBoard.vue,TaskList.vue}` / `web/src/lib/task_sort.ts`：重构（抽取并复用任务展示排序 comparator，降低规则漂移风险，保持排序语义不变）。
- `web/src/lib/chat_sync.ts`：重构（抽取消息过滤 helper，并将 overlap 检测从双层循环改为 key-based `Set` 匹配，保持“最新重叠点”语义不变）。
- `web/src/lib/live_activity.ts`：重构（抽取类别标签映射、pending command 消费与最近未绑定步骤查找 helper，保持展示语义不变）。

### Docs

- `docs/code-review-issues.md`：阅读（部分问题已被后续实现覆盖，但仍可作为回归清单）。
- `docs/spec/20260223-1600-project-wide-refactor-pass-1/`：新增（本轮 refactor spec）。
- `docs/spec/20260223-1700-refactor-command-runner-lifecycle/`：新增（`commandRunner` 去重与测试补齐）。
- `docs/spec/20260223-1800-refactor-activity-tracker-tool-invoke/`：新增（`ActivityTracker` 可维护性重构 + 规则违规检测补强）。
- `docs/spec/20260223-1900-project-wide-refactor-pass-2/`：新增（Web `userId` 扩展 + cookie 防御性默认值）。
- `docs/spec/20260223-2200-project-wide-refactor-pass-3/`：新增（Scheduler env flags 去重 + transcript correction flag 去重）。
- `docs/spec/20260223-2300-project-wide-refactor-pass-4/`：新增（JSON safe-parse 工具收敛 + 测试补齐）。
- `docs/spec/20260223-2350-project-wide-refactor-pass-5/`：新增（`safeStringify()` non-throwing + bootstrap 去重）。
- `docs/spec/20260224-0206-project-wide-refactor-pass-6/`：新增（Audio transcription skill discovery 去重）。
- `docs/spec/20260225-0900-fix-duplicate-command-display-in-execute-preview/`：新增（修复 execute preview body 重复回显 `$ <command>`，包括 leading newlines 场景）。
- `docs/spec/20260225-2000-project-wide-refactor-pass-7/`：新增（Graph 批量落盘去重 + soul preferences 解析重构）。
- `docs/spec/20260225-2100-project-wide-refactor-pass-8/`：新增（任务重排 pending 校验更严格 + 测试补齐）。
- `docs/spec/20260225-2245-claude-cli-session-reuse/`：新增（Claude CLI session 捕获与 `--resume` 复用）。
- `docs/spec/20260225-2300-project-wide-refactor-pass-9/`：新增（Web 静态文件服务 stream 收敛 + 前端 API client 错误上下文增强）。
- `docs/spec/20260225-2359-project-wide-refactor-pass-10/`：新增（Tasks attachments 映射去重 + 前端 task 重排实现收敛）。
- `docs/spec/20260226-0005-project-wide-refactor-pass-11/`：新增（Workflow/Graph service `workspace_path` 归一到 workspace root）。
- `docs/spec/20260226-1200-project-wide-refactor-pass-12/`：新增（CLI runner 重复逻辑收敛：spawn wait / hint / JSONL parse / abort lifecycle）。
- `docs/spec/20260226-1712-dedupe-adapter-input-to-string/`：新增（Claude/Gemini adapters prompt text 提取去重：`extractTextFromInput()` 显式 trim 语义 + 测试锁定）。
- `docs/spec/20260226-1730-remove-unused-terminal-text-utilities/`：新增（移除未被引用的 terminal text width utilities）。
- `docs/spec/20260226-1800-extract-shared-stream-parser-utils/`：新增（Claude/Gemini stream parser 共享 types/helpers 抽取去重，保持行为不变）。
- `docs/spec/20260226-2000-project-wide-refactor-pass-13/`：新增（orchestrator 发送管线去重 + ws project sync helper 抽取）。
- `docs/spec/20260227-0800-project-wide-refactor-pass-14/`：新增（TaskStore row mapper 去重 + 前端任务默认选中规则收敛）。
- `docs/spec/20260227-0900-project-wide-refactor-pass-15/`：新增（TaskStore 持久化解析 helper 收敛 + 前端任务展示排序 comparator 去重）。
- `docs/spec/20260227-1000-project-wide-refactor-pass-16/`：新增（Session env/TTL 归一收敛 + 前端 task bundle drafts 状态 helper 去重）。
- `docs/spec/20260227-1100-project-wide-refactor-pass-17/`：新增（任务路由共享 helper 去重 + 前端 task event 分发结构化重构）。
- `docs/spec/20260227-1200-project-wide-refactor-pass-18/`：新增（schedules 路由 helper 去重 + chat history overlap 匹配复杂度收敛）。
- `docs/spec/20260227-1300-project-wide-refactor-pass-19/`：新增（command allowlist 校验去重 + 前端 drafts/project/task-events 结构收敛）。
- `docs/spec/20260227-1400-project-wide-refactor-pass-20/`：新增（task notifications 状态/解析 helper 收敛 + telegram formatter 缓存 + live activity helper 收敛）。
- `docs/spec/20260227-1730-enforce-spec-for-planner-drafts/`：新增（planner 草稿/审批链路强制校验 `specRef` + spec 三件套完整性）。
- `docs/spec/20260227-2330-project-wide-refactor-pass-21/`：新增（Markdown outline helper 去重 + workflow auto-flow 可读性整理）。
- `docs/spec/20260227-2359-project-wide-refactor-pass-22/`：新增（verification flags 语义统一 + ui smoke service allowlist 硬化）。

### Tests

- `tests/utils/inputText.test.ts`：新增（锁定 `extractTextFromInput()` 对 string/parts/images/whitespace 的语义，以及 `trim` 开关行为）。
- `tests/utils/streamingText.test.ts`：新增（覆盖累积/增量/overlap/截断输入场景）。
- `tests/utils/commandRunner.test.ts`：更新（覆盖 abort/timeout/maxOutputBytes）。
- `tests/utils/abort.test.ts`：新增（覆盖 `createAbortError()` / `isAbortError()` 默认与自定义 message 语义）。
- `tests/web/authCookies.test.ts`：更新（`serializeCookie()` 的 `Secure` 默认值语义调整）。
- `tests/web/authSessions.test.ts`：更新（补充会话 TTL/sliding env 配置解析回归覆盖）。
- `tests/web/webUserId.test.ts`：新增（覆盖新/旧 `deriveWebUserId()` 派生稳定性）。
- `tests/web/plannerDraftSpecGuard.test.ts`：新增（planner WS 草稿缺失 `specRef` 时不落库并剥离 `ads-tasks` code block）。
- `tests/telegram/threadStorage.test.ts`：新增（覆盖 `cloneRecord()` 保留 `updated_at` 的迁移语义）。
- `tests/telegram/urlHandler.test.ts`：更新（补齐 `downloadUrl()` 成功/中断/stream error 清理覆盖）。
- `tests/utils/json.test.ts`：更新（覆盖 `safeParseJsonFromUnknown()` / schema parse / `safeStringify()` 异常输入与 `Map`/`Set` 序列化语义）。
- `tests/memory/soul.test.ts`：更新（补齐 Preferences section 后仍有其他 section 时的内容保留覆盖）。
- `web/src/__tests__/execute-preview-queue-order.test.ts`：新增（覆盖 leading newlines 场景下 execute preview `$ <command>` 回显剥离）。
- `tests/tasks/taskStore.test.ts`：更新（新增 `reorderPendingTasks()` 拒绝非 pending id 覆盖；新增 model config upsert/list 映射回归覆盖）。
- `tests/agents/claudeCliAdapter.test.ts`：更新（覆盖 Claude CLI `session_id` 捕获与 `--resume` 复用、in-flight reset 的延迟生效；并锁定 prompt 参数字节级传递语义）。
- `tests/agents/geminiCliAdapter.test.ts`：新增（锁定 `--prompt` 参数字节级传递语义，覆盖 mixed `local_image` + trailing whitespace）。
- `tests/agents/preferencesFlow.test.ts`：更新（新增 `invokeAgent()` 路径的 preference directives 保存/清洗覆盖）。
- `tests/agents/taskStore.test.ts`：更新（新增持久化 JSON 字段损坏场景的安全降级回归覆盖）。
- `tests/agents/verificationRunner.flags.test.ts`：新增（覆盖 verification enable flags 的 invalid/disabled 语义与 ui smoke service allowlist 拦截）。
- `web/src/__tests__/ws-workspace-project-sync.test.ts`：新增（覆盖 `welcome`/`workspace` 下 project path/name/branch 同步与 `pendingCdRequestedPath` 清理语义）。
- `web/src/app/tasks/selection.test.ts`：新增（锁定任务默认选中规则：pending 优先 + priority/queueOrder/createdAt 排序 + fallback 语义）。
- `web/src/lib/task_sort.test.ts`：新增（锁定任务展示排序权重与同状态下 priority/createdAt 比较语义）。
- `web/src/app/taskBundleDraftsState.test.ts`：新增（锁定草稿列表 helper 的 insert/replace/merge/delete/no-op 语义）。
- `web/src/lib/chat_sync.test.ts`：更新（新增重复可比消息场景，锁定 merge 时“最新重叠点” tail 拼接语义）。
- `web/src/lib/markdown.ts`：重构（`extractMarkdownOutlineTitles()` 复用 `analyzeMarkdownOutline()` 的共享实现，避免标题规则漂移）。
- `tests/utils/commandRunner.test.ts`：更新（新增共享 `assertCommandAllowed()` 对 `git push` 拦截回归覆盖）。
- `tests/web/taskTerminalTelegramNotifications.test.ts`：更新（新增 `isTaskTerminalStatus()` 大小写与非法输入覆盖）。
- `web/src/lib/live_activity.test.ts`：更新（新增 maxSteps fallback、latest pending command 覆盖与 unknown category 归一化渲染覆盖）。
- `web/src/__tests__/markdown-outline.test.ts`：更新（新增 `analyzeMarkdownOutline()` 的 `hasMeaningfulBody` 回归覆盖，锁定标题提取语义）。
- `tests/web/taskBundleDraftsRoute.test.ts`：更新（approve 路径缺失 `specRef` / 缺 spec 文件时返回 `400` 的回归覆盖）。

## Refactor Opportunities (Backlog)

### Correctness / Robustness

- （已处理）`src/tasks/executor.ts`：`event.delta` 合并逻辑已增强，并补充 `tests/utils/streamingText.test.ts` 覆盖。
- （已处理）`src/web/utils.ts`：`deriveWebUserId()` 已扩展到 48-bit 熵；并通过迁移逻辑兼容 legacy 32-bit `userId` 的持久化状态。
- （已处理）`src/utils/json.ts`：`safeStringify()` 改为 non-throwing fallback，避免 circular reference / `bigint` 等输入导致响应路径抛错。
- `src/tasks/store_impl.ts`：`purgeArchivedCompletedTasksBatch()` 当前会保留脱链的 `conversations` / `conversation_messages`（`task_id` 为 `ON DELETE SET NULL`）；需确认是否应在 purge 时同步清理或明确“保留会话历史”的策略。

### Maintainability

- （已处理）`src/utils/commandRunner.ts`：抽取共享 lifecycle，减少 pipe/file 重复并补齐测试。
- （已处理）`src/{utils,bootstrap}/commandRunner.ts`：allowlist + `git push` 校验收敛到 `assertCommandAllowed()`，消除跨模块重复实现与规则漂移风险。
- （已处理）`src/utils/abort.ts`：集中 `AbortError` 创建/识别，跨模块统一中断语义并减少重复代码。
- （已处理）`web/src/components/TaskDetail.vue`：文案与 aria-label/title 已统一为中文，并补齐 `queued` / `paused` 状态下的占位提示。
- （已处理）`src/telegram/utils/*Handler.ts`：`AbortError` 创建/识别收敛到 `src/utils/abort.ts`，减少手写 name 分叉。
- （已处理）`src/telegram/utils/urlHandler.ts`：下载失败时清理半写入文件并保留 `cause`，提升可调试性。
- （已处理）`src/telegram/utils/transcriptCorrection.ts`：bool flag 解析收敛到 `src/utils/flags.ts`，删除重复实现。
- （已处理）`src/scheduler/*`：env flag 解析收敛到 `src/utils/flags.ts`，减少重复实现并降低规则漂移风险。
- （已处理）`src/utils/json.ts`：新增 `safeParseJsonFromUnknown()` 并替换多处 `safeJsonParse()`/`parseJson()` 重复实现，统一 JSON parse 语义并补齐测试。
- （已处理）`src/bootstrap/artifacts.ts`：移除本地 `safeStringify()` 重复实现，复用 `src/utils/json.ts`，保持异常路径输出稳定。
- （已处理）`src/agents/tasks/taskStore.ts`：收敛持久化 JSON 解析与 row 字段转换样板，减少重复并保持容错行为。
- （已处理）`web/src/components/{TaskBoard.vue,TaskList.vue}`：收敛任务展示排序规则到 `web/src/lib/task_sort.ts`，降低多处实现漂移风险。
- （已处理）`src/web/server/api/routes/schedules.ts`：收敛 `POST/PATCH` 的 body 解析、compile 错误处理与 spec 激活态组装，降低重复分支漂移风险。
- （已处理）`web/src/lib/chat_sync.ts`：overlap 检测改为 key-based 匹配，降低历史合并复杂度并保持语义稳定。
- （已处理）`src/web/taskNotifications/{store.ts,telegramNotifier.ts}`：终态状态来源、数值归一化与发送侧判定收敛，降低 store/notifier 规则漂移风险。
- （已处理）`web/src/lib/live_activity.ts`：类别映射与命令绑定查找逻辑收敛到 helper，降低分支膨胀与后续维护成本。

### Performance

- 暂无高置信度的性能瓶颈结论（需结合 profiling/trace/真实 workload 再定优先级）。

## Not Yet Reviewed

### Backend (`src/`)

- `src/agents/`（除 `orchestrator.ts` / `hub.ts` / `hub/delegations.ts` / `adapters/*CliAdapter.ts` / `cli/claudeStreamParser.ts` / `cli/cliRunner.ts` / `cli/stripAnsi.ts` / `tasks/taskCoordinator*` / `tasks/taskStore.ts` / `tasks/verificationRunner.ts` 外）
- `src/bootstrap/`（除 `bootstrapLoop.ts` / `worktree.ts` / `agentRunner.ts` / `commandRunner.ts` / `artifacts.ts` / `review/reviewerRunner.ts` 外）
- `src/codex/`（除 `errors.ts` / `events.ts` 外）
- `src/graph/`（除 `crud.ts` / `fileManager.ts` / `service.ts` / `workflowConfig.ts` / `finalizeHelper.ts` / `types.ts` / `autoWorkflow.ts` 外）
- `src/intake/`
- `src/skills/`（除 `loader.ts` 外）
- `src/state/`（除 `database.ts` / `migrations.ts` 外）
- `src/storage/`（除 `migrations.ts` 外）
- `src/tasks/`（除 `executor.ts` / `queue.ts` / `store_impl.ts` / `storeImpl/*` 外）
- `src/telegram/`（除 `utils/{threadStorage,sessionManager,urlHandler,fileHandler,imageHandler,transcriptCorrection}.ts` 外）
- `src/types/`
- `src/utils/`（除已列出的文件外）
- `src/web/`（除 `utils.ts` / `auth/cookies.ts` / `auth/sessions.ts` / `api/taskRun.ts` / `server/ws/server.ts` / `server/ws/handlePrompt.ts` / `server/ws/taskResume.ts` / `server/ws/handleTaskResume.ts` / `server/httpServer.ts` / `server/api/handler.ts` / `server/taskQueue/manager.ts` / `server/planner/taskBundleDraftStore.ts` / `server/planner/specValidation.ts` / `server/api/routes/tasks/{tasks.ts,tasks/taskById.ts,tasks/shared.ts,tasks/chat.ts}` / `server/api/routes/schedules.ts` / `server/api/routes/taskBundleDrafts.ts` / `taskNotifications/{store.ts,telegramNotifier.ts,telegramConfig.ts,schema.ts}` 外）
- `src/workspace/`（除 `detector.ts` / `adsPaths.ts` / `service.ts` / `rulesService.ts` 外）

### Frontend (`web/src/`)

- `web/src/app/`（除 `chatExecute.ts` / `taskBundleDrafts.ts` / `taskBundleDraftsState.ts` / `tasks.ts` / `tasks/localState.ts` / `tasks/selection.ts` / `tasks/reorder.ts` / `tasks/events.ts` / `projectsWs/webSocketActions.ts` / `projectsWs/projectActions.ts` / `projectsWs/wsMessage.ts` 外）
- `web/src/components/`（除 `TaskDetail.vue` / `TaskBoard.vue` / `TaskList.vue` 外）
- `web/src/lib/`（除 `task_sort.ts` / `chat_sync.ts` / `live_activity.ts` / `markdown.ts` 外）
- `web/src/main.ts` / `web/src/App.vue`
- `web/src/__tests__/`（除 `execute-preview-queue-order.test.ts` 外）
