# ADS 自举（跨项目闭环）- 设计

## 1. 一句话版本
把目标项目放进一个隔离副本里，ADS 自动循环“改代码 → 跑 lint/test → 失败就带报错继续改”，最多 10 轮；一旦 lint/test 全绿就自动 commit 并交付结果。

## 2. 总体架构（组件拆分）
建议把能力拆成“可复用核心” + “ADS 集成层”，避免把自举逻辑绑定在某一个入口（Web/CLI/Telegram）。

### 2.1 bootstrap-core（可复用核心）
核心只关心 4 个抽象：
- `AgentRunner`：把一个目标 + 约束交给 agent 执行，产出变更（通过 Git diff/patch 观测）。
- `Sandbox`：提供一个隔离的项目边界与命令执行能力（必须能保证“读不到边界外文件”）。
- `RecipeResolver`：给定项目目录，得出 `install/lint/test` 等命令（可自动探测或显式配置）。
- `ArtifactStore`：持久化每轮输出、diff、策略切换信息，便于追溯与人工接管。

### 2.2 bootstrap-ads（ADS 集成层）
集成层负责：
- 入口形态（Web UI / API / CLI / 任务编排）
- 使用 ADS 现有的状态目录（`ADS_STATE_DIR`）与 per-project lock
- 复用现有的命令 allowlist 与 verification runner
- 输出与 UI 展示（每轮日志、最终 commit、失败 diff）

## 3. 数据流（一次 run 的完整闭环）
```text
User Goal
  |
  v
BootstrapController
  |
  +--> SandboxManager (create worktree + sandbox boundary)
  |
  +--> RecipeResolver (detect/install/lint/test recipe)
  |
  +--> IterationLoop (max 10)
         |
         +--> AgentRunner (edit code in worktree)
         |
         +--> Verification (lint -> test)
         |
         +--> if pass: GitCommitter -> Done
         |
         +--> else: FailureFeedback -> StrategyEngine -> next iteration
  |
  +--> Artifacts + Final Report
```

## 4. Sandbox 设计（worktree + 读边界隔离）
你的约束里最硬的一条是“不允许读项目外文件”。单纯 `git worktree` 并不能提供安全边界，所以必须叠加 OS 级沙盒（或容器）。

### 4.1 目录布局（建议）
在 `ADS_STATE_DIR` 下为每个目标项目建立一个“自举根目录”，所有允许读写的东西都放在里面：
```text
$ADS_STATE_DIR/bootstraps/<project_id>/
  repo/                 # a normal git repo (acts as worktree base)
  worktrees/<run_id>/   # git worktree checkout used for this run
  artifacts/<run_id>/   # logs, verification outputs, reports
```

说明：
- `repo/` 与 `worktrees/<run_id>/` 必须位于同一自举根目录内，否则 `git worktree` 的 `.git` 指针会指向边界外目录，破坏“不能读外部文件”的承诺。
- `project_id` 建议由“canonical repo identity”派生：优先 remote URL；否则使用绝对路径 realpath，再做哈希与 slug。

### 4.2 OS 级隔离（推荐 bwrap；可选 Docker）
**推荐默认使用 bubblewrap (`bwrap`)** 来保证文件读边界：
- 将自举根目录 bind 到沙盒内的 `/workspace`
- 只暴露必要的系统只读目录（`/usr`, `/lib`, `/bin` 等）
- 将 `HOME`, `TMPDIR`, `XDG_*_HOME`, `PIP_CACHE_DIR`, `NPM_CONFIG_CACHE` 等指向 `/workspace` 内部子目录
- 允许网络：不启用 `--unshare-net`

关键点：对 agent 与 verification 命令都必须在同一边界内运行（否则 agent 依然能从宿主读取外部文件）。

如果环境无法使用 `bwrap`，可以提供 Docker 作为替代后端；但在 MVP 中建议把 “hard sandbox” 作为必须条件，不满足就拒绝运行（避免给用户错误安全预期）。

## 5. Recipe（install/lint/test）设计
### 5.1 Recipe 数据模型（概念）
```json
{
  "version": 1,
  "install": [{ "cmd": "npm", "args": ["ci"] }],
  "lint": [{ "cmd": "npm", "args": ["run", "lint"] }],
  "test": [{ "cmd": "npm", "args": ["test"] }],
  "env": {
    "CI": "1"
  }
}
```

建议支持：
- 多条命令（例如 Python 先创建 venv，再安装依赖）
- 每条命令的 `timeoutMs`、期望 exit code、必要断言（复用现有 `VerificationSpec` 的表达能力）

### 5.2 Node/TypeScript 自动探测（MVP）
优先从 `package.json` 的 scripts 推断：
- `install`：
  - 有 `package-lock.json`：`npm ci`
  - 有 `pnpm-lock.yaml`：`pnpm install --frozen-lockfile`
  - 有 `yarn.lock`：`yarn install --frozen-lockfile`
- `lint`：优先使用 `npm run lint` / `pnpm lint` / `yarn lint`（必须存在对应 script，否则要求显式配置）
- `test`：优先使用 `npm test` / `pnpm test` / `yarn test`（必须存在对应 script，否则要求显式配置）

说明：MVP 不强行假设使用 `vitest/jest`，因为跨项目误判的成本很高。

### 5.3 Python 自动探测（MVP）
依赖管理：
- `uv.lock`：`uv sync --frozen`
- `poetry.lock`：`poetry install --no-interaction --no-ansi`
- `requirements.txt`：`python -m venv .venv` + `.venv/bin/pip install -r requirements.txt`

验收命令：
- `test`：优先 `pytest`
- `lint`：优先 `ruff check .`（存在 `pyproject.toml` 且包含 ruff 配置时启用）；否则要求显式配置

### 5.4 显式配置（跨项目通用）
自动探测无法覆盖所有仓库，因此需要一个可显式覆盖的入口：
- 每次 run 的参数里直接给 `recipe`
- 或者在 ADS 的项目状态目录里存放 `<project_id>.json`
- 或者允许目标项目带一个 `ads.bootstrap.json`（取决于你是否希望把配置入库）

## 6. IterationLoop（最多 10 轮）细节
### 6.1 每轮输入与输出
每一轮迭代都应该固定产出 3 份信息：
- `diff summary`：这轮改了什么（文件列表 + 关键片段摘要）
- `verification report`：lint/test 的 stdout/stderr 与通过/失败原因
- `decision log`：是否触发了策略切换、是否触发了依赖重装等

这三份信息会被压缩后喂回下一轮 agent，形成闭环。

### 6.2 依赖安装的触发时机
建议执行策略：
- run 开始时必跑一次 `install`
- 若 agent 修改了依赖声明（如 `package.json` / lockfile / `pyproject.toml` / `requirements.txt`），则在下一次 verification 之前重跑 `install`

### 6.3 验收顺序
默认顺序建议 `lint -> test`：
- lint 通常更快，能更早给出明确失败点
- 但提供策略可切换为 `test -> lint`（例如某些项目 lint 过慢）

## 7. 卡住时换策略（StrategyEngine）
### 7.1 “卡住”的可操作定义
当出现以下任意情况，可认为卡住并触发策略切换：
- 连续 N 轮（建议 2 或 3）失败原因“同一类且同一错误签名”基本不变
- 连续两轮 diff 为空或几乎无实质变化
- 明显环境问题反复出现（例如依赖安装失败、缓存污染）

### 7.2 MVP 的策略集合（按成本递增）
建议至少提供 3 个策略，并按顺序自动升级：
1) `normal_fix`：仅把失败输出喂回 agent，让其修复
2) `clean_deps`：清理依赖目录并重装（Node: `node_modules`; Python: `.venv`），再继续修复
3) `restart_agent`：重启执行器（spawn 天然优势）以减少上下文漂移，并用更强约束/更明确的“下一步行动清单”重试

可选增强（非 MVP 必需）：
- `model_escalation`：切到更强模型或启用 ADS 的 coordinator，让一个 agent 做诊断、另一个做实现

## 8. 自动 commit（安全 staging 策略）
### 8.1 何时 commit
MVP 建议只在成功时 commit：
- 避免把失败状态污染成一串“半成品提交”
- 降低后续合并/审阅成本

### 8.2 staging 策略（避免误提交依赖与大文件）
默认策略建议：
- 只允许提交“文本文件”与体积小于阈值（例如 1 MiB）的文件
- 默认拒绝提交以下目录：`node_modules/`, `.venv/`, `dist/`, `build/`, `coverage/`, `__pycache__/`
- 如果出现需要提交的生成文件（如 lockfile、snapshot），允许通过显式 allowlist 覆盖

commit message 模板建议统一、可检索：
```text
bootstrap: <short goal summary>
```

并在 worktree 内设置固定的 bot identity（局部 git config）：
```text
user.name=ads-bootstrap
user.email=ads-bootstrap@local
```

## 9. 可观测性与产物（Artifacts）
每次 run 建议落盘：
- `report.json`：包含 run spec、最终状态、通过的命令、commit hash、耗时
- `iterations/<i>/lint.{stdout,stderr}`、`iterations/<i>/test.{stdout,stderr}`
- `iterations/<i>/diff.patch`
- `strategy.log`

这些产物用于：
- Web UI 展示进度
- 人工接管时快速定位
- 未来做统计（哪些项目最常卡在哪一类错误）

## 10. 为什么 spawn 对自举“有优势”
spawn 的优势是工程上的，不是概念上的：
- **易重启**：策略切换时可以无痛重启 agent，避免上下文漂移或状态泄漏
- **易隔离 cwd**：直接把 cwd 指向 worktree，天然把文件读写范围缩小到项目边界
- **易控资源**：超时、kill、并发限制更容易做对

但要强调：spawn 不是自举本身；自举成立的关键仍是“可验证的闭环”与“硬隔离的沙盒边界”。

## 11. 跨项目复用性
只要把“怎么验收”抽象为 `recipe`，这套闭环就可用于任何项目：
- ADS 内部作为功能：Web/CLI/任务编排调用同一个 `bootstrap-core`
- ADS 外部作为库：其它系统只要实现 `AgentRunner` 和 `Sandbox` 接口，也能复用闭环逻辑

## 12. 主要风险与对策
- 供应链风险（允许联网 + 安装依赖）：必须强隔离，且建议把缓存目录放在沙盒内，避免污染宿主。
- 误提交风险：必须有 staging 策略与大小/目录限制；必要时要求人工确认再提交。
- flaky tests：检测到“同一 commit 下反复一会儿过一会儿不过”时，应标记为 `flaky` 并停止自动迭代，转人工处理。

