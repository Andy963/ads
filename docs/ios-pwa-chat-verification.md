# iOS PWA 对话回归验证

## 0.2.24 输入时递归更新修复

0.2.23 的输入框仍将 `composerExpanded` 同时作为 post watcher 的输入和输出。受控故障注入让真实输入框的 `scrollHeight` 随展开状态翻转时，可以复现相同的渲染器栈和未完成 patch 的节点树；完整栈反复出现的是 Vue 调度器 `flushJobs`。仅凭栈顶的 patch 函数重复或新树中的 `el=NULL`，不能认定 VNode 存在环。

修复将展开判断放在独立、不可交互的测量节点上，使用紧凑布局的可用宽度及输入框的文字样式。展开状态变化后只调整实际高度，不再重新决定展开状态。ResizeObserver 也区分外部宽度变化和布局输出造成的尺寸变化，避免通过下一帧重新接回反馈回路。清空输入或卸载组件时释放测量节点。

新增生产构建回归覆盖 WebKit 和 Chromium 的逐字输入、软换行、缩短后收起、依赖展开状态的尺寸故障注入、组合输入和五行上限；报告记录所测资源哈希。此检查使用隔离的 HTTP/WS 固定数据，不能替代下方真实 WebSocket 回归或 iPhone PWA 验收。

```bash
npm run build
npm run test:web -- client/src/__tests__/composer-layout-feedback.test.ts
npm run test:composer-layout-browser
npm run test:chat-browser
```

真机重点复查：更新后不重开页面，连续输入跨越软换行边界，删短、清空、重新输入，再发送并继续输入；分别覆盖中文候选词期间和回复进行中。若仍报错，保留版本号及最早一条诊断。

## 0.2.12 结构变更（切换无效根因）

真机诊断（弹窗探针）确认"发送后切换 Advisor/Worker 无效"有两个叠加机制：

1. 点击被吞：触摸指针流被 pointercancel/位移判定中断时，tapActivation 抑制了随后合成的 click，pointerup 又未激活，导致这次点击完全失效。修复：抑制窗口内若未激活过，则把该 click 当作唯一激活机会执行。
2. 渲染器损坏：lane 面板原为 `v-if/v-else` + 每次切换自增 generation 的 `:key`，每次切换都整体卸载/重建 45+ 条消息的子树；在流式更新排队期间做这种交换会在 Vue 卸载遍历中踩到空节点（`parentNode`/`nextSibling`/`component.emitsOptions` 为 null），交换补丁中途崩溃，DOM 永远卡在旧面板。修复：两个面板改为 `v-show` 常驻，切 lane 只做显隐切换不再重建（`setActiveChatLane` 不再自增 generation；generation 仅随 project 变化），彻底消除交换竞态。

真机诊断弹窗仍在生效（版本 v0.2.13，弹窗带堆栈、出错组件的父链与 props 键）。若真机仍复现，弹窗会直接给出堆栈与组件身份。

v0.2.13 追加：真机报告"输入时"出现 Vue 渲染器崩溃（`Maximum call stack size exceeded`，堆栈为 `patch → processElement → patchElement → patchUnkeyedChildren` 循环；以及 `patchProp → shouldSetAsProp` 修补 `el=null` 的元素）。本地 WebKit 对抗复现（45+ 条历史窗口化、IME 组合输入、流式期间切 lane/切 project/新会话轮换后立即输入）未复现，根因待真机弹窗的组件身份信息定案。作为过渡，渲染/补丁类错误会自动重挂载 lane 面板（上限 3 次，见 `client/src/lib/errorRecovery.ts`），避免整机卡死到重启。

## 自动化范围

`npm run test:chat-browser` 使用构建后的前端、真实 ADS WebSocket 路由和临时 SQLite 历史存储。只有认证/配置 HTTP 响应及模型适配器使用固定测试数据；不连接生产服务，不调用真实模型，不读取真实对话。

WebKit 覆盖移动触摸、两路非空历史、发送后清空、组合输入、草稿隔离和键盘视口变化；Chromium 覆盖桌面回归。刷新后的历史必须由服务端重放，而不是在浏览器中直接注入。

关键触发顺序是“发送过一次之后”，不能只验收初始空输入框。自动化会在同一个未重建的输入框中连续发送两次，显式挂起回复，在忙碌期间逐行输入到五行，再切换两路历史和草稿；移动端还会在前两次发送后再次组合输入并发送，检查迟到的组合输入结束事件不会恢复旧文本或覆盖新草稿。全过程不刷新页面。同时收集未捕获异常与控制台错误，避免漏掉 Vue 捕获后仅输出到控制台的更新异常。

回归还会先安装旧 Service Worker，再保持旧页面打开进行更新，要求新 Worker 不依赖旧页面发送升级消息就能完成激活与接管。自定义注册脚本下必须显式设置 `skipWaiting` 和 `clientsClaim`，不能只依赖插件的 `autoUpdate` 标志。

```bash
npm ci
npx playwright install --with-deps webkit chromium
npm run lint
npm run build
npm test
npm run test:web
npm run test:chat-browser
```

报告与截图保存在命令输出指向的临时目录。可以用 `ADS_CHAT_BROWSER=webkit` 或 `ADS_CHAT_BROWSER=chromium` 单独运行一个引擎；`ADS_CHAT_BUILD_DIR` 可指定待检验的前端构建产物。失败用例会返回非零退出码。

## 真机验收边界

Linux/macOS WebKit 不是安装在 iPhone 上的 PWA。自动化中的组合输入和键盘视口变化是事件模拟，不能替代真实 iOS 输入法、系统键盘和独立窗口验收，也不能证明旧 PWA 已取得新资源。

获得部署授权并部署后，还需要在安装的 PWA 中验证：

1. 记录 iOS 版本、加载的 JS/CSS 资源路径及 Service Worker 控制状态。
2. Advisor、Worker 各保留不同的非空历史；键盘展开时反复切换，检查标题、历史和草稿保持同一路，取消滑动手势不触发切换。
3. 用中文输入法保留候选词状态后发送；检查发送的是完整文本，只发送一次，输入框清空并收回一行。输入锁定时草稿不得丢失。
4. 逐行输入及粘贴长文本；正常可用空间下须显示完整五行，超过五行才内部滚动。展开/收起键盘及前后台切换后重新检查。
5. 发送过程中切换到另一路，再返回；确认响应进入原会话。刷新后再次验证两路历史，并在 PC 上回归普通点击、Enter 发送和 Shift+Enter 换行。
6. 最后必须不刷新、不重开 PWA：先发送一次，然后在原输入框继续输入五行并再次发送，随后切换 Advisor/Worker，连续检查三项行为。分别覆盖回复进行中和回复完成后，不能通过重新挂载输入框掩盖发送后的问题。

没有上述真机结果时，交付状态应明确写为“代码和自动化回归完成，真机验收待验证”，不能直接关闭移动端验收。
