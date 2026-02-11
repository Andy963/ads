# ADR-0017: Delegate Tavily Web Search to Skill Scripts

- Status: Accepted
- Date: 2026-02-11

## Context

ADS 需要在 Web/Telegram 等入口提供“联网搜索 + URL 抓取”的能力，用于在需要时补充最新信息与外部参考。之前该能力以“内置 runtime 集成”的方式存在（`src/tools/search/**`），由核心代码负责：

- API Key 解析与切换（`TAVILY_API_KEY(S)`）
- 请求超时、重试、限流
- 输出格式化与日志

但在实际使用与维护中，我们观察到：

- 联网能力本质是可选扩展：很多环境没有 Key/没有网络，核心 runtime 不应强依赖该能力。
- Tavily SDK/联网依赖会放大 core 的维护面（错误分类、限流策略、日志/脱敏等），并影响测试与可移植性。
- ADS 已引入 “skill” 作为可热加载的扩展机制（`.agent/skills/<name>/SKILL.md`），更适合承载“可选、外部依赖强、更新频繁”的能力。

因此，需要把 Tavily 能力从 core runtime 中剥离，迁移到 skill 侧，并保持用户体验（仍可用 `/search <query>`）。

## Decision

1. 移除内置 Tavily runtime 集成：删除 `src/tools/search/**` 相关实现，不再在 core 内维护 Tavily 的限流/重试/key 管理等逻辑。
2. 将 Tavily 能力下沉为 skill：
   - skill：`.agent/skills/tavily-research/`
   - CLI 脚本：`.agent/skills/tavily-research/scripts/tavily-cli.cjs`
   - 脚本提供 `search` 与 `fetch` 子命令，输出 JSON（便于上层渲染/复用）。
3. `/search <query>`（Telegram / Web Console）保留，但改为 **thin wrapper**：
   - 若缺少 `TAVILY_API_KEY`：回退为本地工作区搜索（`docs/spec` + `docs/adr`）。
   - 若已配置：通过 `src/utils/tavilySkillCli.ts` 调用 skill 脚本并格式化输出。

## Alternatives Considered

1. **继续保留内置 `src/tools/search/**`**
   - 优点：core 内可集中控制限流、重试、日志等策略。
   - 缺点：core 维护面变大，外部依赖更重；对无网络/无 Key 环境不友好。

2. **仅通过远程工具/外部代理提供 Tavily**
   - 优点：core 无需直接集成 Tavily。
   - 缺点：`/search` 在 Telegram/Web 等入口难以稳定复用；配置分散且对用户不透明。

3. **把 Tavily 完全交给用户手动脚本，不提供 wrapper**
   - 优点：core 更轻。
   - 缺点：用户体验下降（入口不一致、输出不统一、难以 discover）。

## Consequences

- 正向：
  - core runtime 更轻：移除 Tavily 相关策略代码，降低维护与测试复杂度。
  - 可选能力更可控：skill 可独立迭代，适配不同运行环境（代理、Key 轮换等）。
  - 用户体验保持一致：仍支持 `/search`，且在未配置 Key 时有明确降级路径。
- 负向/风险：
  - `/search` 运行时依赖 skill 脚本存在（路径约定），部署/打包需确保 `.agent/skills/` 同步。
  - 失去内置的“多 Key/限流/重试”策略（当前由脚本与调用方约束替代），如需恢复需在 skill 侧演进。

## References

- Spec: `docs/spec/20251205-1615-tavily-search-tool/requirements.md`
- Spec: `docs/spec/20251205-1615-tavily-search-tool/design.md`
- Spec: `docs/spec/20251205-1615-tavily-search-tool/implementation.md`
- Skill: `.agent/skills/tavily-research/SKILL.md`
- Code: `src/utils/tavilySkillCli.ts`
