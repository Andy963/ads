# HTTP 合同状态

`routes.json` 是从 TypeScript 路由文件提取的静态清单。动态分发可能导致推断出的
HTTP method 不完整，因此它只是兼容检查表。

首个 Rust 切片已实现鉴权接口：

| Method | Path | 成功响应 | 是否需要鉴权 |
| --- | --- | --- | --- |
| `GET` | `/api/auth/status` | `200 {"initialized": boolean}` | 否 |
| `POST` | `/api/auth/login` | `200 {"success": true}` + `Set-Cookie` | 否 |
| `POST` | `/api/auth/logout` | `200 {"success": true}` + clear cookie | 否 |
| `GET` | `/api/auth/me` | `200 {"id": string, "username": string}` | 是 |

Rust 集成测试和黑盒脚本已经验证这些行为。其余路由必须在 Rust 服务成为默认后端
之前加入黑盒测试。
