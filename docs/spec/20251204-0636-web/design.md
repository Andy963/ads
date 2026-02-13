# Web 移动端适配与图片占位符增强 - 设计方案

## 1. 概览
- 版本：0.1.0 Draft
- 作者：Codex 助手
- 关联需求：`req_hoazlrcg`（docs/spec/20251204-0636-web/01-req.md）
- 范围：仅针对 Web 前端与 WebSocket bridge 的移动端布局、锁定态模糊、消息占位/连接反馈、图片发送与上下文注入；不改动推理/agent 逻辑。

## 2. 当前问题
- 移动端存在 `body` 可滚动、输入框可能横向滚动，锁定态缺少强模糊。
- 消息发送后缺少即时占位/进度反馈，断连时用户不知后台状态。
- Web 前端尚无图片发送通道；WebSocket 仅接受字符串 prompt，未支持二进制/附件元数据；Claude 仅文本，Codex 支持 `local_image`。
- 锁定状态下 token 输入不可用，无法完成解锁。

## 3. 目标方案概览
- 布局：锁定 `body` 滚动，主体用 `100vh` 容器，只有对话内容区滚动；输入框自动换行、隐藏横向滚动条，适配 iPhone XR 等竖屏。
- 锁定态：添加遮罩 + 强模糊（大于 16px blur），保留对话框/输入区交互；token 输入可聚焦提交。
- 消息占位与连接：发送即渲染占位符，1s 节奏动态更新，收到响应/失败后替换；显示 WebSocket 连接状态并自动重连。
- 图片：前端支持选择/拖拽图片，2MB 上限前置校验；通过 WS 发送（base64/Blob），服务端落盘到固定目录并注入 `local_image` 到代理输入；Claude 不支持时入口置灰并提示。

## 4. 组件与改动点
### 4.1 WebSocket Bridge（server）
- 接收新消息格式：`{ type: "prompt", payload: { text: string, images?: ImageMeta[] } }`，其中 `ImageMeta` 包含 `name`, `mime`, `data`（base64）或 `path`。
- 图片落盘：写入 `.ads/temp/web-images/<uuid>.<ext>`，校验大小（服务端兜底 2MB），返回 `local_image` 路径数组；超限或类型不符返回错误。
- 上下文注入：将图片映射为 Codex `Input` 的 `{ type: "local_image", path }`，文本作为 `{ type: "text", text }`。
- 连接状态事件：server 保持现有 `welcome`/`result`/`error`，增加 `status`（connected/reconnecting/disconnected）可选；错误时回传具体原因（超限/不支持）。

### 4.2 前端 UI（假定现有前端）
- 布局：`body { overflow: hidden; }`，外层容器 `min-height: 100vh; display: flex; flex-direction: column;`。对话区 `flex: 1; overflow-y: auto;`；输入区自适应换行，禁用横向滚动。
- 锁定态：添加半透明遮罩 + `backdrop-filter: blur(16px)` 或等效方案，锁定时仅遮罩内容区；输入/token 输入保持可用。
- 占位符：发送后立即插入消息项，显示 Telegram Bot 风格动态图标/省略号，1s 切换；失败状态显示重试按钮/说明；成功用响应替换。
- 连接状态：在头部或状态栏显示 `连接中/已连接/重连中/已断开`，断开时禁用发送按钮或提示。
- 图片发送：文件选择/拖拽，前置校验 ≤2MB、常见图片 MIME；不支持（Claude）时按钮灰显并提示“当前模型不支持图片，请切换 Codex”。

## 5. 数据与校验
- ImageMeta：`{ name: string; mime: string; size: number; data: string }`（base64，前端传输）；服务端重新验证 `size` 和 `mime`。
- 存储路径：`.ads/temp/web-images/<uuid>.<ext>`；需确保目录存在并有清理策略（本迭代先留在 temp，可后续计划补充清理任务）。
- 输入构造：`Input = [{type:"text", text}, ...images.map(p => ({type:"local_image", path: p}))]`。
- 尺寸限制：前端 + 服务端双层 2MB 上限；超限即拒绝。

## 6. 连接与重试策略
- WebSocket：断开后指数退避重连（示例：1s, 2s, 5s, 10s 上限），UI 状态同步。
- 消息发送：发送时若未连接，提示“正在重连”并阻止发送或排队；失败后占位符转失败态，可重试一次（重新发送相同 payload）。

## 7. 兼容性与降级
- Agent 能力：Claude 不支持图片 → 前端按钮灰显，服务端如收到 images + Claude 则返回错误提示。
- 旧客户端：若前端仍发送纯字符串 `payload`，服务端保持兼容（按旧逻辑处理）。

## 8. 测试要点
- 移动端视口：iPhone XR 模拟，确认无 body 滚动、输入无横向滚动条，锁定态模糊覆盖且可输入 token。
- 占位符：发送立即出现，占位符每秒变化；成功/失败替换正确。
- 图片：2MB 上下边界、非图片 MIME 拦截；成功后图片路径正确写入上下文（日志/调试可见）。
- 连接：断网→重连，状态提示更新；发送时断连的提示与阻断生效。

## 9. 风险与缓解
- 大文件/多图导致内存占用：前端预校验 + 服务端大小校验。
- 模糊影响性能：限制模糊区域仅内容区，使用合理 blur 值并避免整个页面重绘。
- 兼容性风险：保留旧协议路径，前端/后端均需判空 images。

## 10. 发布与回滚
- 发布：后端接口改动与前端同步上线；需验证 WebSocket 新消息格式。若前端未更新，旧格式仍可用。
- 回滚：可禁用图片入口与占位符动态效果，服务器保留旧字符串处理路径，无需数据迁移。

