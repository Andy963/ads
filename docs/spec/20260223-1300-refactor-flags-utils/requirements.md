# Requirements

## 背景

当前代码库在多个模块中重复实现了环境变量（env flags）的解析逻辑（例如 boolean、positive int），细节略有差异，导致维护成本上升，也更容易出现“不一致的默认/非法值处理”。

## 目标

- 在 `src/utils/flags.ts` 中补齐可复用的解析函数：
  - `parseOptionalBooleanFlag(value)`：未设置或非法值返回 `undefined`
  - `parsePositiveIntFlag(value, defaultValue)`：缺失/非法/非正数回退到 `defaultValue`
- 迁移语义一致的调用点，删除/收敛局部重复实现。
- 不改变现有行为与默认值策略，保持测试与功能不回退。

## 非目标

- 不变更任何 env 名称。
- 不强行统一所有“特殊语义”的解析规则（例如“只要不是 0 就启用”之类的开关）。

## 约束

修改后需通过：

```bash
npx tsc --noEmit
npm run lint
npm test
```

## 验收标准

- 上述校验命令通过。
- 重复解析函数减少，并且 `docs/REFACTOR.md` 有更新记录。
