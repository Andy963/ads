# Implementation Plan: Together Image Generation Skill

## 准备事项
- [x] 确认约束：实现必须以 skill 形式落地（`.agent/skills/**`），API key 读取自环境变量。
- [x] 确认运行时：Node.js `>= 20`（项目 engines）。

## 阶段任务

- [ ] T1. 新增 spec 三件套
  - 位置：`docs/spec/20260212-together-image-skill/`
  - 内容：`requirements.md` / `design.md` / `implementation.md`

- [ ] T2. 新增 skill 与脚本
  - 新增：`.agent/skills/together-image/SKILL.md`
  - 新增：`.agent/skills/together-image/scripts/together-image.cjs`
  - CLI 设计要点：
    - 默认输出 base64 到 stdout（仅一行）
    - key 缺失直接失败
    - 支持 `--out` 写文件
    - `b64_json` 缺失时对 `url` 做回退下载并编码

- [ ] T3. 验证
  - 命令（不含 Together key 的情况下至少能验证静态检查）：
    - `npx tsc --noEmit`
    - `npm run lint`
    - `npm test`
  - 手动验证（需要配置 `TOGETHER_API_KEY`）：
    - `node .agent/skills/together-image/scripts/together-image.cjs --prompt "Cats eating popcorn" > /tmp/img.b64`
    - `base64 -d /tmp/img.b64 > /tmp/img.png`（或 `--out /tmp/img.png`）

## 风险与回滚
- 风险：Together 上游可能返回 URL 而非 base64；通过 URL 回退逻辑降低风险。
- 回滚：删除 `.agent/skills/together-image/` 与对应 spec 目录即可，不影响主工程逻辑。

