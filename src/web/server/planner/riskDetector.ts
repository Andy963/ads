import type { TaskBundle } from "./taskBundle.js";

export interface RiskDetectionResult {
  isHighRisk: boolean;
  reasons: string[];
}

const DESTRUCTIVE_PATTERNS = [
  "delete",
  "drop table",
  "truncate",
  "force push",
  "reset --hard",
  "rm -rf",
  "rollback migration",
  "revert migration",
];

const SCHEMA_PATTERNS = [
  "database migration",
  "schema change",
  "breaking change",
  "public api change",
  "storage schema",
  "cross-service",
];

const SECURITY_PATTERNS = [
  "auth",
  "permission",
  "secret",
  "token",
  "credential",
  "password",
];

const UNDERSPECIFIED_PATTERNS = [
  "todo",
  "tbd",
  "open question",
  "assumption",
  "not sure",
  "unclear",
];

function collectText(bundle: TaskBundle): string {
  return bundle.tasks
    .map((t) => `${t.title ?? ""} ${t.prompt ?? ""}`)
    .join(" ")
    .toLowerCase();
}

export function detectBundleRisk(bundle: TaskBundle): RiskDetectionResult {
  const text = collectText(bundle);
  const reasons: string[] = [];

  for (const keyword of DESTRUCTIVE_PATTERNS) {
    if (text.includes(keyword)) {
      reasons.push(`涉及破坏性操作 (${keyword})`);
    }
  }

  for (const keyword of SCHEMA_PATTERNS) {
    if (text.includes(keyword)) {
      reasons.push(`涉及架构/协议变更 (${keyword})`);
    }
  }

  for (const keyword of SECURITY_PATTERNS) {
    if (text.includes(keyword)) {
      reasons.push(`涉及安全敏感变更 (${keyword})`);
    }
  }

  for (const keyword of UNDERSPECIFIED_PATTERNS) {
    if (text.includes(keyword)) {
      reasons.push(`存在未明确定义内容 (${keyword})`);
    }
  }

  return {
    isHighRisk: reasons.length > 0,
    reasons,
  };
}
