/**
 * 清除字符串中的 ANSI 转义序列。
 *
 * CLI 输出有时会包含颜色代码（如 \x1b[32m），
 * 在 JSON.parse 前需要先清理掉。
 *
 * 参考：luban/crates/luban_backend/src/services/ansi.rs
 */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  const csiPattern = /\x1b\[[0-9;]*[a-zA-Z]/g;
  // eslint-disable-next-line no-control-regex
  const simpleEscPattern = /\x1b./g;
  return input.replace(csiPattern, "").replace(simpleEscPattern, "");
}
