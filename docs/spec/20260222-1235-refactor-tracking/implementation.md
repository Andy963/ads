# Implementation

## 本次落地内容

1. 新增 `docs/REFACTOR.md` 并纳入版本控制（调整 `.gitignore` 放行该文件）。
2. 首个低风险重构示例：将重复的布尔环境变量解析逻辑收敛为 `src/utils/flags.ts`：
   - `src/telegram/botSetup.ts` 通过 re-export 对外保持 API 不变。
   - `src/web/server/startWebServer.ts` 直接复用共享实现，删除本地重复函数。

## 验证

```bash
npx tsc --noEmit
npm run lint
npm test
```

