import { createLogger, type Logger } from "../utils/logger.js";
import { findSecurityViolation } from "../middleware/builtin/globalRulesMiddleware.js";

export type EnforcementDecision = "allow" | "require_approval" | "deny";
export type EnforcementMode = "observe" | "enforce";

export interface EnforcementRequest {
  agent: string;
  channel: string;
  workspace: string;
  tool: string;
  command?: string;
  paths?: string[];
  userExplicitlyApproved: boolean;
}

export interface RuleHit {
  ruleId: string;
  title: string;
  category: string;
  severity: "advisory" | "required" | "approval_required" | "blocked";
  matchedOn: string;
}

export interface EnforcementResult {
  decision: EnforcementDecision;
  effectiveDecision: EnforcementDecision;
  mode: EnforcementMode;
  hits: RuleHit[];
}

export function resolveEnforcementMode(raw?: string): EnforcementMode {
  const value = String(raw ?? process.env.ADS_RULE_ENFORCEMENT_MODE ?? "").trim().toLowerCase();
  return value === "enforce" ? "enforce" : "observe";
}

export interface RuleEnforcementGateOptions {
  logger?: Logger;
  mode?: EnforcementMode;
}

/**
 * Evaluate only immutable machine-safety guardrails.
 *
 * The mode is retained for caller compatibility and observability. A built-in
 * safety violation is always effective, including when mode is observe.
 */
export function createRuleEnforcementGate(options: RuleEnforcementGateOptions = {}) {
  const logger = options.logger ?? createLogger("RuleGate");
  const getMode = (): EnforcementMode => options.mode ?? resolveEnforcementMode();

  const evaluate = (request: EnforcementRequest): EnforcementResult => {
    const mode = getMode();
    const violation = findSecurityViolation(request.command ?? "");
    const hits: RuleHit[] = violation
      ? [{
          ruleId: "builtin-security",
          title: "Built-in security guardrail",
          category: "safety",
          severity: "blocked",
          matchedOn: "command:" + violation,
        }]
      : [];
    const decision: EnforcementDecision = violation ? "deny" : "allow";

    if (violation) {
      logger.warn(
        "[" + mode + "] deny agent=" + request.agent +
          " channel=" + request.channel +
          " tool=" + request.tool +
          " command=" + violation.slice(0, 160) +
          " rule=builtin-security",
      );
    }

    return {
      decision,
      effectiveDecision: decision,
      mode,
      hits,
    };
  };

  return { evaluate, getMode };
}

export type RuleEnforcementGate = ReturnType<typeof createRuleEnforcementGate>;

let defaultGate: RuleEnforcementGate | null = null;

export function getRuleEnforcementGate(): RuleEnforcementGate {
  if (!defaultGate) {
    defaultGate = createRuleEnforcementGate();
  }
  return defaultGate;
}

export function resetRuleEnforcementGate(): void {
  defaultGate = null;
}
