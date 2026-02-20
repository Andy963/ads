# Requirements

## 背景
当前 `gemini` 适配链路存在两类问题：
1. 部分 thinking 文本会与最终回答进入同一 assistant 输出；
2. 当 `result` 事件失败时，真实错误可能位于嵌套字段（如 `result.error.message`），但系统仅展示通用 `gemini result error`。

## 目标
- 在不改动对外协议的前提下，将 Gemini 的 reasoning/thinking 与 final answer 分流。
- 提升 `result/error` 失败信息可读性，优先透传真实错误原因。
- 保持现有 `tool_use/tool_result/result` 主流程行为稳定。

## 功能要求
1. 当输入事件显式标识为 thinking/reasoning（如 `kind/subtype/channel/message_type` 含相关语义）时：
   - 解析为内部 `reasoning` item；
   - 不得写入最终 `agent_message`。
2. 对常见独立 thinking 占位文本（如 `Thinking...`）应进行最小兜底识别并分流到 reasoning。
3. 非 reasoning 的 assistant 文本继续按原逻辑累积为最终回答。
4. `result` 失败时应优先读取嵌套错误信息（如 `error.message`）并传递给上层；不得退化为泛化错误文案（除非确无信息）。
5. `result.status` 对 `success/ok/completed` 应按成功处理。
6. `result.status` 缺省时：若出现 `error/reason/message`（含嵌套）则按失败处理；否则按成功处理。

## 非功能要求
- 改动应保持最小化、可回滚。
- 需补充回归测试，覆盖“分流成功且不污染最终回复”与“失败信息透传”。
