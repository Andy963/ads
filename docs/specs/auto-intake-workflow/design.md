# 自动需求建档功能设计方案

## 1. 总体流程
```
handleLine()
  ├─ 检查 WorkflowContext
  ├─ 若无活动工作流 & 非命令 → classifyInput()
  │     ├─ 调用 Codex（非流式）判断 task/chat/unknown
  │     └─ 返回 task → startIntake()
  └─ 其他情况 → 原有流程

startIntake()
  ├─ createWorkflow(title)
  ├─ 初始化 intakeState（必填字段进度）
  ├─ 写入 requirement.md 草稿
  └─ promptClarification()

promptClarification()
  ├─ 找出缺失字段
  ├─ 输出提问并等待用户回答
  ├─ persistAnswer() → 更新 intakeState & requirement.md
  └─ 重复直到全部补齐 → finalizeRequirement()
```

## 2. 模块划分
- `src/intake/classifier.ts`
  - 封装调用 Codex 的输入分类逻辑；接受原始文本，返回 `"task" | "chat" | "unknown"`。
  - 支持注入 prompt，可在测试中 mock。
- `src/intake/service.ts`
  - 管理需求收集流程：创建工作流、维护 intake state、生成追问。
  - 提供 `startIntake(initialInput)`、`handleAnswer(text)` 等接口。
- `src/intake/storage.ts`
  - 负责读写 `.ads/intake-state.json`，内容包括当前工作流 ID、已收集字段、待提问字段等。
- CLI 集成
  - 在 `handleLine` 中接入 `classifier` & `service`。
  - 当 `service` 返回“等待回答”状态时，阻止 Codex 派发，直接打印提示。

## 3. 数据结构
```ts
interface IntakeState {
  workflowId: string;
  fields: Record<IntakeField, string>;
  pending: IntakeField[];
}

type IntakeField = "background" | "goal" | "scope" | "constraints" | "acceptance";
```

## 4. 澄清策略
- 每次仅询问一个字段，按优先级 `goal → background → scope → constraints → acceptance`。
- 用户回答后立即写入 state，并追加到 `requirement.md` 对应段落。
- 若回答为“未知/暂无”，仍写入说明，但保留 `pending` 以提醒后续补齐。

## 5. 文档同步
- `requirement.md`：按照模板段落填入用户回答；初始输入放在“需求概述”区块。
- `design.md`/`implementation.md`：若不存在，则从模板复制空文件，保留 TODO 标记。
- 完成后在 CLI 输出：“需求已确认，位于 docs/specs/<slug>/requirement.md”。

## 6. 交互细节
- `chat` 分类 → 原样交给 Codex。
- `unknown` → CLI 输出提示要求用户明确是聊天还是任务，可提供 `/ads.new` 指令帮助。
- 进行中的 intake → 用户输入优先视为字段答案，直到收集完成或用户输入 `/ads.cancel`（可选）。

## 7. 错误处理
- 分类失败或 Codex 超时 → 回退为 `unknown`，提示用户手动创建。
- 工作流创建失败 → 打印错误并终止 intake。
- state 文件损坏 → 忽略旧状态并重新开始。

## 8. 扩展接口
- 未来可在 `IntakeState` 中增加 `history` 字段，保存澄清问答记录。
- 可选支持“命名建议”“优先级”字段，用于扩展项目管理。
