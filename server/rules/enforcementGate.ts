import { createLogger, type Logger } from "../utils/logger.js";

import { getGlobalRuleService, type GlobalRuleService } from "./globalRuleService.js";
import type { GlobalRule, RuleMatch } from "../state/globalRuleStore.js";

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
  severity: GlobalRule["severity"];
  matchedOn: string;
}

export interface EnforcementResult {
  /** Decision the rule set calls for, regardless of the active mode. */
  decision: EnforcementDecision;
  /** Decision the caller must honour. In observe mode this is always `allow`. */
  effectiveDecision: EnforcementDecision;
  mode: EnforcementMode;
  hits: RuleHit[];
}

const DECISION_RANK: Record<EnforcementDecision, number> = {
  allow: 0,
  require_approval: 1,
  deny: 2,
};

const regexCache = new Map<string, RegExp | null>();

function compilePattern(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) {
    return regexCache.get(pattern) ?? null;
  }
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern, "i");
  } catch {
    compiled = null;
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

function listIncludes(list: string[] | undefined, value: string): boolean {
  if (!list || list.length === 0) return true;
  const needle = String(value ?? "").trim().toLowerCase();
  return list.some((entry) => entry.trim().toLowerCase() === needle);
}

function hasTrigger(match: RuleMatch): boolean {
  return Boolean(
    (match.tools && match.tools.length > 0) ||
      (match.commandPatterns && match.commandPatterns.length > 0) ||
      (match.pathPatterns && match.pathPatterns.length > 0),
  );
}

/**
 * Decide whether a rule applies to this request.
 *
 * `agents` / `channels` / `tools` narrow the scope; `commandPatterns` /
 * `pathPatterns` are the triggers. A rule that carries no trigger at all is
 * injection-only and never fires here — this keeps a prose-only rule from
 * blocking every command by accident.
 */
export function matchRule(rule: GlobalRule, request: EnforcementRequest): string | null {
  const match = rule.match;
  if (!match || !hasTrigger(match)) return null;
  if (!listIncludes(match.agents, request.agent)) return null;
  if (!listIncludes(match.channels, request.channel)) return null;
  if (!listIncludes(match.tools, request.tool)) return null;

  const command = String(request.command ?? "").trim();
  if (match.commandPatterns && match.commandPatterns.length > 0) {
    if (!command) return null;
    for (const pattern of match.commandPatterns) {
      const regex = compilePattern(pattern);
      if (regex?.test(command)) {
        return `command:${pattern}`;
      }
    }
  }

  const paths = (request.paths ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
  if (match.pathPatterns && match.pathPatterns.length > 0) {
    for (const pattern of match.pathPatterns) {
      const regex = compilePattern(pattern);
      if (paths.some((candidate) => regex?.test(candidate))) {
        return `path:${pattern}`;
      }
    }
  }

  const hasPatternTriggers =
    (match.commandPatterns?.length ?? 0) > 0 || (match.pathPatterns?.length ?? 0) > 0;
  if (hasPatternTriggers) {
    return null;
  }
  // Tool-scoped rule with no pattern: fires on every request for that tool.
  return `tool:${request.tool}`;
}

export function resolveEnforcementMode(raw?: string): EnforcementMode {
  const value = String(raw ?? process.env.ADS_RULE_ENFORCEMENT_MODE ?? "").trim().toLowerCase();
  return value === "enforce" ? "enforce" : "observe";
}

function decisionForSeverity(
  severity: GlobalRule["severity"],
  userExplicitlyApproved: boolean,
): EnforcementDecision {
  if (severity === "blocked") return "deny";
  if (severity === "approval_required") {
    return userExplicitlyApproved ? "allow" : "require_approval";
  }
  return "allow";
}

export interface RuleEnforcementGateOptions {
  service?: GlobalRuleService;
  logger?: Logger;
  mode?: EnforcementMode;
}

export function createRuleEnforcementGate(options: RuleEnforcementGateOptions = {}) {
  const logger = options.logger ?? createLogger("RuleGate");
  const service = options.service ?? getGlobalRuleService();

  const getMode = (): EnforcementMode => options.mode ?? resolveEnforcementMode();

  const evaluate = (request: EnforcementRequest): EnforcementResult => {
    const mode = getMode();
    let rules: GlobalRule[] = [];
    try {
      rules = service.listEnabledRules();
    } catch (error) {
      logger.warn(
        `rule evaluation degraded, no rules applied: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const hits: RuleHit[] = [];
    let decision: EnforcementDecision = "allow";
    for (const rule of rules) {
      const matchedOn = matchRule(rule, request);
      if (!matchedOn) continue;
      hits.push({
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        severity: rule.severity,
        matchedOn,
      });
      const next = decisionForSeverity(rule.severity, request.userExplicitlyApproved);
      if (DECISION_RANK[next] > DECISION_RANK[decision]) {
        decision = next;
      }
    }

    const effectiveDecision: EnforcementDecision = mode === "enforce" ? decision : "allow";
    if (decision !== "allow") {
      const summary = hits
        .filter((hit) => hit.severity === "blocked" || hit.severity === "approval_required")
        .map((hit) => `${hit.severity}:${hit.title}`)
        .join(", ");
      logger.warn(
        `[${mode}] ${decision} agent=${request.agent} channel=${request.channel} tool=${request.tool} ` +
          `command=${String(request.command ?? "").slice(0, 160)} rules=[${summary}]`,
      );
    }

    return { decision, effectiveDecision, mode, hits };
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

/** Test hook: drop the process-wide gate so the next call rebinds to a fresh service. */
export function resetRuleEnforcementGate(): void {
  defaultGate = null;
}
