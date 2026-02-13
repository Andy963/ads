# Web 移动端适配与图片占位符增强 - 实施计划

## 范围与排除
- In scope：Web 前端布局/锁定态、消息占位符与连接状态、图片发送（2MB 上限）与服务器落盘、WS 协议扩展（文本+图片）。
- Out of scope：线程上下文恢复、前端本地消息缓存/恢复（按要求暂不实现）；Claude 图片支持（保持不支持时灰显/报错）；非 Web 渠道改动。

## 任务拆解
- [ ] T1 WebSocket 协议与服务端处理  
  - Files：`src/web/server.ts`（消息解析、错误返回、local_image 注入）、可能新建 `src/web/utils/imageStorage.ts`（按需）。  
  - Steps：  
    - 支持 `{text, images?}` payload；旧字符串保持兼容。  
    - 校验图片 MIME/大小≤2MB，保存到 `.ads/temp/web-images/<uuid>.<ext>`。  
    - 将文本/图片映射为 Codex `Input`：text + `{type:"local_image", path}`；Claude 收到 images 返回不支持错误。  
    - 错误提示明确（超限/格式不符/未授权）。  
  - Verification：超限/非图被拒；图成功时日志含落盘路径；旧纯文本路径可用。

- [ ] T2 前端消息与连接态（无本地缓存）  
  - Files：Web 前端代码（同现有 UI 路径，待确认），仅修改当前页面，不引入持久化。  
  - Steps：  
    - 发送即插入占位符气泡（Telegram Bot 三点动画，1s 节奏），成功/失败替换。  
    - 显示 WS 状态（连接中/已连/重连/断开），断开禁用发送并提示；自动重连但不清空列表。  
    - 锁定态：仅允许 token 输入，其他输入禁用；背景强模糊遮罩。  
  - Verification：占位符出现与替换正常；断开后状态提示与禁用生效；锁定时只可输入 token。

- [ ] T3 前端图片发送（2MB 前置校验）  
  - Files：Web 前端代码。  
  - Steps：  
    - 选择/拖拽图片，前端校验 ≤2MB、常见图片 MIME；构造 `{text, images}` payload。  
    - Claude/不支持图片时入口灰显并提示。  
  - Verification：2MB 边界提示；Codex 路径被注入并发送成功；不支持时 UI 禁用。

- [ ] T4 移动端布局与锁定模糊  
  - Files：Web 前端样式/布局。  
  - Steps：`body overflow: hidden;` 100vh 容器；对话区 `overflow-y: auto`；输入区自动换行无横向滚动；锁定态遮罩 + blur>16px。  
  - Verification：iPhone XR 视口无全局纵向滚动/无输入横向滚动；锁定模糊覆盖且不影响 token 输入。

- [ ] T5 验证与回归  
  - Steps：  
    - 手动：移动端模拟（iPhone XR），发送文本+图片；占位符/失败态/重连；锁定流程。  
    - 边界：图片 1.9MB / 2.1MB、非图片 MIME。  
    - 兼容：纯字符串 payload 仍可通。  
  - Verification：记录手测结果；必要时附运行命令/截图路径。

## 风险与应对
- 性能：模糊/动画耗时 → 仅遮罩内容区，动画简单三点。  
- 存储膨胀：临时目录增长 → 本迭代仅落盘，按需后续加清理脚本。  
- 兼容性：旧客户端 → 保留旧字符串处理路径，错误提示明确。

## 交付出口
- 提交分支：待开发时确认。  
- 测试命令：以项目既有测试/构建为准（无自动测试则提供手测记录）。  
- 完成标准：T1–T5 验收通过后可进入代码实现与 Review。

