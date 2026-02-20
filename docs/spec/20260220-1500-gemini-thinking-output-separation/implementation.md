# Implementation

## 变更项
1. `src/agents/cli/geminiStreamParser.ts`
   - 新增 reasoning 缓冲与 `isReasoningMessage` 判定。
   - 在 `parseMessage` 中先做 reasoning 分流并发出 `item.updated(type=reasoning)`。
   - 新增 `extractNestedMessage`，在 `parseResult/parseError` 提取嵌套错误。
   - 扩展 `parseResult` 成功状态判定（`success/ok/completed` 视为成功；缺省状态仅在无 `error/reason/message` 时视为成功）。
2. `tests/agents/geminiStreamParser.test.ts`
   - 新增 reasoning 分流回归测试（显式 metadata + token 兜底）。
   - 新增 `result.error.message` 透传测试。
   - 新增 `status=completed` 成功路径测试。
   - 新增“缺省 status + error payload => failure”回归测试。

## 验证
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
