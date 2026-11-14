# 兼容合同

这些文件由 TypeScript 实现在指定 commit 上生成，是 Rust 实现和一致性测试的输入。

- `sqlite/state.sql`：全部 state 迁移以及 Web 鉴权表执行后的最终 DDL。
- `sqlite/workspace.sql`：全部 workspace 迁移执行后的最终 DDL。
- `sqlite/state-seed.sql` / `sqlite/workspace-seed.sql`：新库初始播种数据；
  毫秒时间戳归一化为稳定序号，保留原始排序关系。
- `sqlite/manifest.json`：schema 版本和对象数量。
- `auth/password-vector.json`：确定性的 Node 兼容 scrypt 向量。
- `state/upstream-credential-vector.json`：TypeScript 生成的 upstream credential
  加密向量，用于 Rust 解密和反向互操作测试。
- `http/routes.json`：静态路由清单，不是完整行为合同。
- `ws/frames.json`：静态 WebSocket 帧清单与握手元数据。

不要手工修改生成文件。应修改 TypeScript 源或提取脚本，然后重新生成。
