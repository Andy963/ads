# Telegram Workspace Initialization Reminder Design

## 1. Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | Aligns with requirements |
| Status | Draft | Awaiting review |
| Authors | ADS JS Telegram |
| Stakeholders | CLI team, Telegram bot operator |
| Created | 2025-11-09 |
| Last Updated | 2025-11-09 |
| Related Requirements | `docs/spec/telegram-workspace-init-check/requirements.md` |
| Related Implementation Plan | _TBD_ |

## 2. Context
### 2.1 Problem Statement
- Telegram `/cd` 仅校验路径合法性，不确认 `.ads/workspace.json` 是否存在，导致用户切换到未初始化目录后才在首次 Codex 请求时报错。
- 错误信息来自 SystemPromptManager（instructions 缺失），用户无法立即定位原因，提升了支持成本。

### 2.2 Goals
- 在 Telegram `cd` 命令执行时即时检测初始化状态，并在回复中提示缺失的 `.ads` 资产。
- 记录一次 warning，帮助排查频繁切换到裸目录的用户。
- 保持 `/cd` 的副作用（切换目录 + 会话重置）不变。

### 2.3 Non-Goals / Out of Scope
- 不会自动运行 `ads init` 或写入 `.ads`。
- 不改动 CLI `/cd` 或其他入口的行为。

## 3. Current State
- 系统概述：`DirectoryManager` 负责白名单校验；`SessionManager` 维护 Codex 会话；`SystemPromptManager` 在真正调用 Codex 时才读取 `.ads/templates`。
- 数据流：`/cd` 指令 → `DirectoryManager.setUserCwd` → `SessionManager.setUserCwd` → Codex reset。
- 痛点：
  1. 未初始化目录在第一次 Codex 请求时才失败。
  2. 错误信息模糊，用户难以定位需要 `ads init`。

## 4. Target State Overview
- 方案摘要：引入 `WorkspaceInitChecker`，在 `/cd` 成功后执行只读检测；若缺失 `.ads/workspace.json`（或其他关键文件），返回提示文本与日志记录。
- 关键收益：即时反馈、可追踪、零侵入（不影响 `SessionManager` 行为）。
- 主要风险：额外的 IO 检查可能影响 `/cd` 延迟，但只需少量 `fs.existsSync`，可忽略。

### 4.1 Architecture Diagram
```
User /cd --> DirectoryManager (whitelist + exists)
           --> WorkspaceInitChecker (fs checks .ads/*)
           --> SessionManager (set cwd + reset)
           --> Reply builder (success text + optional warning)
```

### 4.2 Deployment / Topology
- 环境：Node.js Telegram bot（同进程）。
- 服务：无新增服务，逻辑内嵌。
- 存储：读取用户工作区下的 `.ads/*`。

## 5. Detailed Architecture
| Concern | 描述 |
| ------- | ---- |
| 数据流 | `/cd` 命令新增一个同步检测步骤，读取 `.ads/workspace.json` 与 `.ads/templates/instructions.md`。 |
| 控制流 | 检测结果影响回复内容与是否记录 warning，不影响目录切换。 |
| 并发/容错 | 同一用户串行处理；检测失败（异常）将 fail-safe 为“未初始化”。 |
| 可扩展性 | `WorkspaceInitChecker` 可扩展更多校验项，通过配置数组控制。 |

### 5.1 Sequence / Flow
```
User -> Bot (/cd path)
Bot -> DirectoryManager.validate(path)
Bot <- success
Bot -> WorkspaceInitChecker.check(path)
WorkspaceInitChecker -> fs.existsSync(path/.ads/workspace.json)
Bot <- { initialized: false, missing: ".ads/workspace.json" }
Bot -> SessionManager.setUserCwd(path) & reset
Bot -> Reply "已切换... ⚠️ 缺少 ... 请运行 ads init"
Bot -> Logger.warn(...)
```

## 6. Components & Interfaces
### Component 1: WorkspaceInitChecker
- 责任：集中定义需要检查的 `.ads` 资产并输出状态。
- 输入：目标目录绝对路径。
- 输出：`{ initialized: boolean; missingArtifact?: string; details?: string }`
- 接口：`checkWorkspace(path: string): WorkspaceInitStatus`.
- 依赖：`fs`, `path`.
- 影响面：Telegram `/cd` 命令。

### Component 2: Bot Reply Builder
- 责任：根据 `WorkspaceInitStatus` 拼接提示文本。
- 输入：现有成功回复 + 检测结果。
- 输出：最终发送给 Telegram 的字符串。
- 依赖：`SessionManager`, Logger。

## 7. Data & Schemas
- `WorkspaceInitStatus`：
  ```ts
  interface WorkspaceInitStatus {
    initialized: boolean;
    missingArtifact?: string;
    details?: string;
  }
  ```
- 命名约定：`missingArtifact` 为文件路径字符串，便于日志与提示。

## 8. APIs / Integration Points
- 内部函数调用，无对外 API 变更。

## 9. Operational Considerations
### 9.1 Error Handling & Fallbacks
- 若 `checkWorkspace` 读取文件时报错，捕获并返回 `initialized=false`、`missingArtifact="unknown"`，同时记录 `logger.warn`，提示“检测失败，视为未初始化”。
- 用户提示保持一致：建议运行 `ads init`。

### 9.2 Observability
- 日志：`logger.warn('[Telegram][WorkspaceInit] user=<id> path=<path> missing=<artifact>')`.
- 指标：暂不新增；若未来需要，可统计警告次数。
- 告警：无。

### 9.3 Security & Compliance
- 所有访问均在白名单目录内；只读 `existsSync`，不会暴露路径以外的信息。

## 10. Testing & Validation
- 单元测试：
  - `WorkspaceInitChecker`：各种文件存在/缺失组合。
  - `/cd` handler 构造：模拟未初始化路径，确认回复包含提醒。
- 手动验证：
  - 在 Telegram Bot 中切换到未初始化目录，检查提示与日志。
  - 切换到已初始化目录，确认无额外文案。

## 11. Release & Rollout
- 发布步骤：`npm run build` → 部署 bot → 观察日志。
- 回滚策略：若提醒干扰用户，可移除 `/cd` 检测（保留 commit 以备复原）。

## 12. Appendix
- N/A
