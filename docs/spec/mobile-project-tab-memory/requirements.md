# Mobile Project Tab Memory Requirements

## 1. 状态与目标

- 状态：Implemented
- 目标：移动端重新进入 ADS 时，默认打开当前项目上一次打开的工作区 Tab。
- 适用 Tab：`Advisor`、`Worker`、`Task`
- 默认 Tab：`Advisor`

当前移动端在 `client/src/App.vue` 中通过 `mobileTaskTabActive` 与 `activeChatLane` 组合计算 `activeWorkspaceTab`，其中 `activeChatLane` 初始值为 `planner`。该状态目前只存在于内存，页面刷新后始终回到 Advisor；项目切换时 `useLaneRuntimeBridge` 还会对 planner 做额外的 worker fallback。新功能需要将移动端 Tab 偏好按项目持久化，并移除与该需求冲突的隐式切换。

## 2. 范围

### 必须修改

1. `client/src/App.vue`
   - 在移动端 Tab 切换成功后保存当前项目的 Tab。
   - 在当前项目初始化完成、项目切换以及重新进入移动端时恢复该项目的 Tab。
   - 保持现有 `activeWorkspaceTab`、Tab 面板可见性和移动端上下文菜单行为一致。

2. `client/src/lib/mobileWorkspacePreferences.ts`（或同等职责的现有前端偏好模块）
   - 提供项目级 localStorage key 构造、Tab 值规范化、读取和写入能力。
   - 仅允许持久化 `tasks`、`planner`、`worker` 三个值。
   - 处理 localStorage 不可用、读取异常和非法值，不得阻断应用启动或项目切换。

3. 相关测试
   - 更新 `client/src/__tests__/mobile-navigation-behavior.test.ts`，覆盖刷新/重新挂载后的项目级恢复和项目切换隔离。
   - 更新 `client/src/__tests__/mobile-pane-tabs.test.ts` 或新增对应 helper 测试，覆盖 key 与非法值规范化。
   - 更新 `client/src/composables/app/useLaneRuntimeBridge.test.ts`：删除或改写“项目切换时 planner 自动转 worker”的旧断言，确保新恢复逻辑拥有唯一决定权。

### 不在范围内

- 不修改服务端、WebSocket 协议、数据库 schema 或项目 API。
- 不把移动端 Tab 偏好同步到服务端、其他浏览器或其他用户。
- 不改变桌面端的 Tab 默认值、Tab 顺序或桌面端会话行为。
- 不持久化抽屉模块（项目/规则/Provider）、Provider 子项、任务选中项或聊天内容。
- 不新增脚本、部署配置或运行中的 ADS 服务操作。
- 不删除已有 localStorage 项目数据；旧版本没有该 Tab key 时按默认值处理。

## 3. 数据与存储契约

### 存储介质

使用浏览器 `localStorage`。这是纯 UI 偏好，不进入 ADS 状态库，因为它只描述当前浏览器用户在当前设备上的导航习惯，不参与任务执行或会话恢复。

### Key

每个项目使用独立 key：

```text
ads.mobileWorkspaceTab.<projectId>
```

其中 `<projectId>` 使用当前项目的 `activeProjectId`，包括 `default`。Key 构造必须对空白输入进行规范化；当项目 ID 为空时不得读写一个共享的未知项目 key，直接使用默认 Tab。

### Value

Value 为以下三个字符串之一：

```text
tasks
planner
worker
```

读取结果必须经过白名单校验。缺失、空字符串、非法值、存储读取异常均返回 `planner`。

写入失败应静默降级为仅保持当前内存状态；不得抛出未处理异常。

## 4. 行为要求

### 4.1 首次使用与恢复

1. 当前项目 ID 可用后，移动端读取该项目的 Tab 偏好。
2. 有效缓存为 `tasks` 时设置 `mobileTaskTabActive = true`；为 `planner` 或 `worker` 时设置 `mobileTaskTabActive = false` 并设置对应的 `activeChatLane`。
3. 没有有效缓存时使用 Advisor，即 `planner`。
4. 恢复过程不得触发 Tab 点击副作用、上下文菜单操作或项目切换请求。
5. 恢复只影响当前项目；不能读取上一个项目的缓存作为新项目的默认值。

### 4.2 Tab 点击与写入

1. 仅移动端点击 `Task`、`Advisor` 或 `Worker` 后写入缓存。
2. 写入值必须与点击后的 `activeWorkspaceTab` 完全一致。
3. 点击当前已激活 Tab 仍可安全写入同一值，但不得产生额外网络请求。
4. 桌面端不写入该移动端偏好 key。桌面端继续沿用现有 lane 行为。
5. 保存偏好不应影响面板渲染、聊天 lane、任务队列或上下文菜单关闭逻辑。

### 4.3 项目切换

1. 移动端从项目 A 切换到项目 B 后，恢复 B 的缓存。
2. 若 B 没有缓存，B 显示 Advisor，而不是沿用 A 的当前 Tab。
3. 切回 A 后，A 恢复 A 自己最近一次保存的 Tab。
4. 项目切换期间若项目 ID 短暂为空，不能覆盖任何项目的缓存。
5. 现有 `useLaneRuntimeBridge` 中“项目切换且当前为 planner 时自动改为 worker”的行为必须删除或改为不再影响最终恢复结果，避免与项目级缓存产生竞态。

### 4.4 响应式断点变化

1. 从桌面切换到移动端时，按当前项目读取移动端缓存。
2. 从移动端切换到桌面端时，不清除移动端缓存。
3. 桌面端期间选择 lane 不得覆盖移动端缓存。
4. 如果无法检测到当前项目，保持安全默认值 Advisor，待项目 ID 可用后再恢复。

## 5. 实现边界与建议结构

推荐将持久化细节封装在 `client/src/lib/mobileWorkspacePreferences.ts`，避免在 `App.vue` 中散落 key、白名单和异常处理逻辑。

建议提供以下最小接口；可以采用等价命名，但不应扩大为通用服务端偏好 API：

```ts
export type MobileWorkspaceTab = "tasks" | "planner" | "worker";

export function buildMobileWorkspaceTabStorageKey(projectId: string): string;
export function normalizeMobileWorkspaceTab(value: unknown): MobileWorkspaceTab;
export function readMobileWorkspaceTab(projectId: string): MobileWorkspaceTab;
export function writeMobileWorkspaceTab(projectId: string, tab: MobileWorkspaceTab): void;
```

`App.vue` 负责把持久化值映射到现有的两个响应式状态。项目 ID 和移动端断点的 watch 应保证恢复操作幂等；不要在 watch 回调中调用模拟用户点击的完整处理函数，以免产生菜单关闭或其他 UI 副作用。

## 6. 验收标准

### 自动化测试

至少覆盖以下场景：

1. 初次挂载且当前项目没有缓存时，移动端激活 Advisor。
2. 预置项目 A 的 `worker` 缓存后挂载，移动端激活 Worker。
3. 预置项目 A 为 `tasks`、项目 B 为 `planner`，在 A/B 之间切换时分别恢复各自 Tab。
4. 在移动端依次点击 Task、Advisor、Worker，localStorage 中对应项目的值分别更新。
5. 在桌面端点击 lane，不写入移动端 Tab key。
6. localStorage 中存在非法值、损坏值或访问抛错时，应用仍能启动并回退 Advisor。
7. 从移动端切换到桌面再回到移动端时，当前项目的移动端缓存仍然生效。
8. 现有三 Tab 面板只显示 active Tab，且 Task/Advisor/Worker 的上下文操作不回归。

测试不得依赖真实浏览器持久化或网络服务；使用现有 Vitest/jsdom 能力隔离 localStorage，并在每个测试前清理存储。

### 手工检查

在移动端按以下顺序检查：

1. 项目 A 打开 Worker，刷新页面，确认仍打开 Worker。
2. 切换到项目 B，确认无缓存时打开 Advisor；在 B 打开 Task。
3. 切回项目 A，确认恢复 Worker；刷新后 A/B 的偏好仍分别保持。
4. 调整窗口宽度在移动/桌面断点两侧切换，确认桌面操作不会覆盖移动端偏好。
5. 在浏览器禁用或模拟 localStorage 读取失败，确认页面仍可用且回退 Advisor。

## 7. 验证命令

在仓库根目录执行：

```bash
npm run lint
npm run test:web
npm run build:web
```

本功能涉及 `client/src`，交付实现时 `npm run build:web` 为必需校验。若同时修改了共享 TypeScript 模块，再运行仓库既有的完整测试命令并报告实际退出码。Spec 阶段不执行上述实现校验，也不执行构建、部署或服务重启。

## 8. 交付边界

实现阶段只应包含移动端偏好 helper、App/bridge 中必要的恢复与写入逻辑、相关前端测试，以及本 Spec 的必要同步。不得执行 `git commit`、`git push`、`npm run deploy:local` 或 ADS 服务重启，除非后续获得明确授权。
