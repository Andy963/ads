# ADR 0012: Encrypt User-Scoped Upstream Discovery Credentials

## Status

Accepted

## Context

Issue #234 要求记住上游模型发现配置，其后续安全澄清禁止把 API key 写入浏览器存储。直接把新的 URL 与服务端默认密钥组合，还会把既有密钥发送到用户刚输入的其他地址。

## Decision

- 使用既有 `kv_state` 保存每个认证用户最近成功使用的发现配置，不引入数据库迁移。密钥用 AES-256-GCM 加密，认证附加数据绑定用户、规范化 endpoint 和 provider。
- 从 `ADS_WEB_SESSION_PEPPER` 以 HKDF 派生用途隔离的加密密钥；未配置时，在状态数据库旁生成独立的 32 字节密钥文件，权限为 `0600`。数据库及已有 WAL 文件也在写入前收紧到 `0600`。
- 配置查询仅返回地址、provider 和密钥存在标志，并禁止 HTTP 缓存；密钥不返回前端、不进入 localStorage。成功发现后清空前端输入框，后续请求省略密钥时由后端解密。
- 只有规范化后仍相同的 endpoint 才能复用既有密钥。切换地址必须提供新密钥，上游请求禁止自动重定向。新配置只有在发现成功后覆盖旧配置。
- 保留选择性导入；本任务不替换 Codex runtime，不把发现凭据写入可公开读取的模型 JSON。

## Consequences

备份时必须同时保留数据库和 pepper／独立密钥文件。更换 pepper 或丢失密钥会使旧凭据不可解密，需要重新输入；不会静默回退到另一个 provider 的密钥。加密保护数据库备份，但不能防御已经控制服务进程的攻击者。
