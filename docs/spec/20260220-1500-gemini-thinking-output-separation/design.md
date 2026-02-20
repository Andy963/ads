# Design

## 设计概要
在 `GeminiStreamParser` 做两项最小修复：
1. `parseMessage` 前置 reasoning 判定并分流；
2. `parseResult/parseError` 增加嵌套错误消息提取，增强状态兼容。

## 关键决策
1. **不改 WS 协议与前端结构**
   - 复用现有 `reasoning` item 与 `handlePrompt` 的 step 分发逻辑。
2. **优先元数据，文本兜底最小化**
   - 降低 reasoning 误判风险。
3. **失败信息就近提取**
   - 从 `message/error/reason` 及其嵌套对象中提取可读错误，确保 UI 呈现真实原因。
4. **状态向后兼容**
  - `success/ok/completed` 视为成功；缺省状态仅在不存在 `error/reason/message`（含嵌套）时视为成功，避免静默吞掉失败。

## 风险与缓解
- 风险：文本兜底规则仍可能对边界文案存在误判。
- 缓解：规则收窄为状态 token 与 thought 前缀。
- 风险：将缺省 `status` 视为成功可能掩盖异常输入。
- 缓解：仅在 `result` 事件中采用该策略；若有明确错误字段仍会走失败分支。
