# Implementation

## 改动概览

- `src/agents/cli/claudeStreamParser.ts`
  - `parseResult()`: treat `subtype: "success"` with `error`/`reason`/`message` as failure and emit `turn.failed`.
  - Add `extractNestedMessage()` to extract nested error details such as `error.message`.
- `tests/agents/claudeStreamParser.test.ts`
  - Add regression test: `subtype: "success"` with `error: { message: "x" }` must produce an error event.

## 验证

```bash
npx tsc --noEmit
npm run lint
npm test
```

