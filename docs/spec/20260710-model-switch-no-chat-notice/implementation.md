# 模型切换不写入聊天记录实现计划

## 步骤

1. 修改 `server/web/server/ws/sessionOverrides.ts`，模型切换时不再设置 `notice`。
2. 保留模型配置应用、用户模型更新和 reasoning effort 更新逻辑。
3. 更新 `tests/web/sessionOverrides.test.ts` 中模型切换测试的断言。
4. 更新 `tests/web/slashCommandsDisabled.test.ts` 中模型切换历史回放测试，改为断言不写入模型 notice。
5. 运行相关测试、类型检查、lint、全量测试和前端构建。

## 风险

1. 如果移除了有效模型元数据，前端模型展示可能不同步。缓解方式是只移除 notice，不改 `effectiveModel`。
2. 如果误删代理切换提示，用户可能看不到执行主体变化。缓解方式是只调整模型 notice，保留 `agentNotice`。
