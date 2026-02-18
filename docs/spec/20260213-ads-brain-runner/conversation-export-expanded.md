# 对话导出（扩展重构版）

说明：

- 这是从本次 chat 线程中，与 `runner/ingest/brain` 架构讨论相关的内容做的**扩展版重构**。
- 我仍然剔除了大量重复的系统/规则提示块（它们太吵），但会把**关于 `brain` / `ingest` / 定时调度 / 可观测性**的关键推理写完整，而不是只给 bullet。
- 它不是“逐字逐句的 raw log”（因为原线程里系统提示重复很多、噪音巨大），但会尽量保持我们讨论时的语义与推进顺序；并把此前你指出“缺失的 `brain/ingest` 细节”完整补进来。

---

## 01. 你要的不是“单次对话 agent”，而是可持续的 control loop（runner/daemon）

**User**

你希望 ADS 有一个后台常驻的 `runner`：即便 web/telegram 重启也不影响；它能执行耗时长、定时的任务（例如分析代码、提 issue、跟踪外部系统产物）。

**Assistant**

关键点不在于“能不能跑一个脚本”，而在于**能不能形成闭环**：

- 现在 web/tg 更像“被动入口”：你发一次消息，它跑一次，然后结束。
- 但像 Jules/GitHub 这种外部产物往往是异步的：你触发一次，结果可能 10 分钟后才出现；如果没有常驻组件，就没人去**持续检查、推进状态、触发下一步**。
- 结论：需要一个常驻组件来维护“状态机 + 调度 + 幂等”，也就是我们后面叫的 `brain`。

---

## 02. 你担心上下文串台/爆炸：brain 不应该是“一个永远变长的 LLM thread”

**User**

如果 brain 接收所有项目所有对话，最后会串上下文、爆炸、错乱。你还类比人脑：人脑怎么做到不串台？

**Assistant**

这类问题的根因，通常是把 brain 想成了“一个永远追加的 prompt”。如果这么做，必炸。

更合理的拆法是：

- `brain` 不维护“全局长对话上下文”，它维护的是**结构化状态**（可落库、可裁剪、可索引）。
- 真正需要“读懂本轮输出并判断是否相关”的工作，交给一个短生命周期的 `ingest`：一次性 agent / 一次性模型调用，跑完就结束，**不保留对话线程**。
- 这样“智能”是存在的（因为 ingest 会读），但“长期上下文”不是用 prompt 叠起来的，而是用结构化状态承载。

当你说“人脑不串台”，工程映射是：

- 人脑工作记忆容量是硬上限（bounded），不会无限增长；
- 记忆是索引化的（按场景线索检索），不是把所有经历拼成一段长文本；
- 有强 gating：绝大多数输入不会进入工作记忆，只会形成弱痕迹或直接丢弃。

对应到系统就是：`ingest` 做 gating，`brain` 做索引化的状态机推进，而不是“把所有聊天原文喂给一个长期 LLM”。

---

## 03. 你质疑：ingest 没上下文怎么判断“无关”？brain 不是也会膨胀？

**User**

1) `ingest` 什么上下文都没有，它怎么判断消息是不是有用信息？  
2) `brain` 不断接收 ingest 输出，上下文不也在不断膨胀吗？

**Assistant**

先把两个“膨胀”区分开：

1. **prompt 膨胀**：把所有东西都塞进模型上下文，这个一定会爆。
2. **状态膨胀**：DB 里的事件/事实/任务会增长，但这是可控的，因为它是结构化、可压缩、可 TTL 的。

所以我们要做的是：**允许 DB 增长，但禁止 prompt 无界增长**。

### 3.1 ingest 需要的上下文不是“全量对话历史”，而是“最小可判定上下文”

`ingest` 的输入不需要把整个项目代码读一遍，也不需要把全历史对话塞进去。

它需要的是“让它能做分类/提炼的最小集合”，通常来自三个地方：

- **事件外壳（event envelope）**：告诉它“这是哪个 workspace、来自 planner 还是 worker、关联哪个 task、是否有 PR/Issue/sessionId”等。
- **本次产物（artifacts）**：比如本轮生成了哪些文件/Spec/patch、worker 跑了哪些命令、exit code、错误摘要、diffstat、外链（PR/Issue/Jules session）。
- **该 workspace 的状态切片（workspace state slice）**：不是大段文本，而是结构化的小片段，例如：
  - 当前正在追踪的外部对象（哪些 Jules session / PR / issue 在 watch）
  - 当前 open 的 todo/decision 列表（短）
  - 最近 N 条高重要度 facts（短）

这三类加起来，足够让 ingest 判断“这条消息对当前状态机有没有增量”，并产出结构化结论。

### 3.2 brain 的“膨胀”如何控制

brain 的增长应该发生在 DB 里，并用规则控制：

- `facts`/`memory fragments` 必须有 `ttl`，到期自动过期；
- 高价值的 `decision` 可以长期保留，但仍应有上限与可 merge 策略；
- `events`（原始 ingest 报告）可以只保留一段时间（例如 7/30/90 天），或保留摘要；
- `jobs` 进入 terminal 状态后，可以 archive。

因此“增长”变成一个工程可控问题（compaction/TTL/limits），而不是 prompt 失控。

---

## 04. 你问：最小上下文怎么来？不又得 LLM 再处理一遍或者读仓库？

**User**

“与该 workspace 当前状态机相关的最小上下文”怎么来？那不又得 LLM 再处理一遍，或者每次都读项目代码？

**Assistant**

最小上下文来自 `brain` 自己维护的状态，而不是每次再读仓库：

- `brain` 接收 ingest 输出后，把结果写入结构化表（例如 `brain_memory_fragments`、`brain_external_trackers`、`brain_jobs`）。
- 下次 ingest 再跑时，`brain` 可以提供一个 bounded 的 state slice：例如“当前 open trackers + top facts + pending jobs”。

也就是说：读仓库/读对话是 ingest 的一次性成本；而最小上下文是 brain 的结构化状态导出，不需要 LLM 再做第二次抽象。

如果确实需要“看代码”，也应该是特定 job 的显式动作（比如 `run_code_audit`），而不是每条 ingest 的默认步骤。

---

## 05. 你问：brain 怎么处理不同项目来的 ingest 消息？（多 workspace 隔离）

**User**

brain 要怎么处理不同项目来的 ingest 消息呢？

**Assistant**

关键是不要让不同 workspace 共享一条状态机推进链路。推荐做法是：

- 用 `workspaceId` 做硬隔离（例如 `workspaceRoot` 的 `realpath`）。
- brain 内部用 `workspaceId -> actor/mailbox` 的模型：
  - 同一个 `workspaceId` 的事件串行处理（避免并发写导致状态机错乱）。
  - 不同 `workspaceId` 的事件可以并行（吞吐不会被单个项目拖死）。
- 对每个事件做幂等去重：
  - `eventId` 去重：同一个 ingest 报告重复投递不会重复更新状态。
  - `dedupeKey` 去重：同一个建议 job 不会重复入队。

这就解决了“多项目混在一个 brain 里会串台”的根因：根本不允许它们进入同一条状态推进队列。

---

## 06. 你追问：那 brain 收到消息后“什么也没做”？

**User**

但是这样的话，brain 收到消息后什么也没做啊？

**Assistant**

brain 做的事情不是“每次都用 LLM 思考一遍”，而是**确定性的控制面工作**，至少包括：

1. **路由**：把事件分发到对应 `workspaceId` 的 actor。
2. **幂等去重**：用 `eventId`/`dedupeKey` 保证重复消息不会造成重复动作。
3. **更新状态机**：更新 trackers/memory/jobs（例如记录“这个 Jules session 已创建/已完成/关联 PR #123”）。
4. **生成后续 job**：如果 ingest 输出里建议了 `watch_jules_session`/`watch_github_pr`，brain 会创建持久化 job，安排在未来某个时间点执行。
5. **调度执行 + 可观测记录**：把 job 的执行过程落库，并确保 Web 侧能看到（下面会讲）。

也就是说 brain 不是“没做事”，它做的是 control loop 的“控制面”，恰恰是你之前缺失的那部分。

---

## 07. “worker/planner 结束后自动 ingest”怎么落地：skill + script + 消息格式（event envelope）

**User**

你要求：worker/planner 完成一个对话后调用 skill 起 `ingest agent` 产出消息（`eventEnvelope`），需要定义 ingest skill（包含脚本）、消息格式（存哪些状态信息）。

**Assistant**

这里我们把边界卡清楚：`ingest` 是“一次性流程固化”，所以非常适合做成 skill，并且带脚本，结构类似：

- `.agent/skills/brain-ingest/SKILL.md`：定义契约（输入结构、输出结构、幂等约束、字段解释）。
- `.agent/skills/brain-ingest/scripts/ingest.cjs`：收集工件（artifacts/state slice），调用 LLM（或规则引擎），输出一个 JSON。

输出消息不应该是“随便一段自然语言”，而应该是结构化 `IngestReport`，让 brain 可以 deterministic 地做调度与幂等。

例如（示意）：

```json
{
  "schemaVersion": 1,
  "workspaceId": "string",
  "eventId": "string",
  "source": "web_planner|web_worker|telegram",
  "timestampMs": 0,
  "summary": "string",
  "externalRefs": {
    "julesSessionIds": ["string"],
    "githubPrNumbers": [0],
    "githubIssueNumbers": [0],
    "commitShas": ["string"]
  },
  "facts": [
    { "kind": "decision|todo|finding|link|error", "text": "string", "importance": 0, "ttlHours": 0 }
  ],
  "suggestedJobs": [
    {
      "type": "watch_jules_session|watch_github_pr|create_issue_draft|run_code_audit|notify",
      "runAtMs": 0,
      "dedupeKey": "string",
      "payload": {}
    }
  ],
  "confidence": 0
}
```

这份输出里，“event envelope”核心解决三件事：

- **路由**：`workspaceId` 确保进入正确的 actor；
- **幂等**：`eventId`/`dedupeKey` 确保不会重复触发；
- **状态推进**：`facts`/`externalRefs`/`suggestedJobs` 给 brain 提供 deterministic 的下一步。

---

## 08. brain 的本体形态：常驻服务 +（可选）brain 控制 skill

**User**

你认为 brain 应该是 skill 吗？brain 本身应该常驻，否则无法处理不同 planner/worker 的消息。

**Assistant**

结论是：

- `brain` 本体应该是**常驻服务进程**（类似一个 daemon），否则无法承接“持续接收事件 + 定时调度 + 可恢复”。
- 但 brain 依然可以提供一个**控制面 skill**（例如 `brainctl`），用于交互式地查看状态、触发某个 job、暂停某个 workspace 等。

skill 负责“人可调用的操作入口”，服务进程负责“持续运行的控制回路”，两者角色不同。

---

## 09. 可观测性：brain 如果直接 spawn 进程，Web 看不到怎么办？

**User**

如果 brain 收到消息后要干预某个 worker，让它做一步动作：你直接 spawn 起进程，Web 用户什么也看不到，不具有观测性。

**Assistant**

这是非常关键的工程约束：brain 的价值之一就是让后台行为变得可见、可审计、可回放。

所以原则是：**brain 不直接做黑盒 spawn**，而是把动作映射成“系统里已经可展示的可观测实体”。

最小可行路径通常是：

- brain 在 DB 里创建 `brain_job`（带 `status/runs/last_error/run_at`）。
- brain 把需要执行的动作映射成现有 ADS task queue（或一个新的 job UI，但优先复用 task）：
  - 这样 worker 执行过程产生的日志/状态更新就会自然出现在 Web UI；
  - 用户可以看到：何时触发、为什么触发、执行到哪一步、失败原因是什么、是否可以重试/取消。

也就是说：brain “触发执行”的动作应该是“创建一个可见的 task”，而不是“在后台默默 `spawn` 一个进程”。

如果某些动作需要人工确认（例如创建 issue、关闭 PR），brain 也不应该直接做；它应创建一个 `brain_action`（pending approval），让 Web UI 提示你确认。

---

## 10. 定时事件：用什么触发？失败如何处理？

**User**

如果 brain 添加了定时事件，定时事件用什么来触发？怎么处理？失败了怎么办？

**Assistant**

最稳妥的最小实现是：**持久化 job + tick 轮询**，而不是依赖进程内的 timer 作为唯一真实来源。

核心机制：

- 所有定时事件都写进 `brain_jobs`（持久化），字段至少包括：`run_at_ms`、`status`、`retry_count`、`last_error`、`dedupe_key`。
- brain 主循环每隔 `N` 秒扫描 `run_at_ms <= now AND status=pending` 的 job，取出执行。
- 执行前先把 job 标记为 `running`（避免并发重复跑）。
- 成功 -> `completed`；失败 -> 写 `last_error`，指数退避后重试。

失败处理的底线是“可恢复 + 可解释”：

- `retry_count` + `next_run_at_ms` 做指数退避；
- 超过最大重试后标记 `failed`；
- 进入 `failed` 后应触发可观测的提醒（Web UI 里能看到，或发通知），并保留足够诊断信息（失败阶段、外部返回摘要、时间）。

这样即便 brain 进程重启，job 也不会丢；并且失败不会静默。

---

## 11. 你最后要求的交付物：导出 + 方案文档

**User**

你要求我做两件事：

1) 把开始讨论 runner 结构时的对话导出，保存到 `docs/`。  
2) 把现在讨论出来的方案详细写下来（包括 ingest skill、消息格式、brain 如何处理消息、可观测性、定时事件与失败处理等），用中文写、尽量说人话。

**Assistant**

对应文件已经放在：

- 对话导出：`docs/spec/20260213-ads-brain-runner/` 下的 `conversation-export*.md`
- 方案文档（Spec 三件套）：`docs/spec/20260213-ads-brain-runner/requirements.md`、`design.md`、`implementation.md`

为了避免你再踩“导出太简略”的坑，这个扩展重构版会把 `brain/ingest` 的关键内容写得更完整；后续如果你仍希望“包含系统提示块的 raw log”，我们再单独补一份 raw（但那份会非常长且难读）。

