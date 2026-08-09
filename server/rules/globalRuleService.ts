import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";

import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase } from "../state/database.js";
import {
  createGlobalRuleStore,
  type GlobalRule,
  type GlobalRuleStore,
  type RuleMatch,
  type RuleSeverity,
} from "../state/globalRuleStore.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { PROJECT_ROOT } from "../utils/projectRoot.js";

const SEED_NAMESPACE = "global_rules";
const SEED_KEY = "bootstrap_seeded";

export const GLOBAL_RULES_OPEN_TAG = "<global_rules>";
export const GLOBAL_RULES_CLOSE_TAG = "</global_rules>";

export interface RenderedGlobalRules {
  /** Fully rendered `<global_rules>` block, or an empty string when no rule is enabled. */
  text: string;
  hash: string;
  /** `database` when rules came from state.db, `bootstrap` when the DB was unavailable. */
  source: "database" | "bootstrap";
  degraded: boolean;
  ruleCount: number;
}

export interface GlobalRuleServiceOptions {
  db?: DatabaseType;
  logger?: Logger;
  templateRulesPath?: string;
}

type SeedSpec = {
  match?: RuleMatch;
  severity: RuleSeverity;
  category: string;
};

/**
 * Enforceable overrides applied while importing `templates/rules.md`.
 * Keyed by a stable substring of the template line; everything else is
 * imported as an injection-only `required` instruction.
 */
const SEED_OVERRIDES: Array<{ marker: string } & SeedSpec> = [
  {
    marker: "数据库文件",
    category: "safety",
    severity: "approval_required",
    match: {
      tools: ["shell", "bash", "command"],
      commandPatterns: ["\\b(rm|unlink|shred|truncate)\\b[^\\n]*\\.(db|sqlite|sqlite3)\\b", ">\\s*[^\\s]*\\.(db|sqlite|sqlite3)\\b"],
      pathPatterns: ["\\.(db|sqlite|sqlite3)$"],
    },
  },
  {
    marker: "提交策略",
    category: "safety",
    severity: "approval_required",
    match: {
      tools: ["shell", "bash", "command"],
      commandPatterns: ["\\bgit\\s+(commit|push)\\b"],
    },
  },
  {
    marker: "进程自保",
    category: "execution",
    severity: "blocked",
    match: {
      tools: ["shell", "bash", "command"],
      commandPatterns: [
        "\\b(pkill|killall)\\b",
        "systemctl(\\s+--user)?\\s+(stop|disable|mask|kill)\\s+[^\\n]*ads(-web|-tg)?\\b",
        "\\bkill\\b[^\\n]*\\$\\(\\s*(pgrep|pidof)\\b",
      ],
    },
  },
];

/** Extra rules that have no counterpart in `templates/rules.md`. */
const EXTRA_SEEDS: Array<{ title: string; body: string } & SeedSpec> = [
  {
    title: "部署需显式授权",
    body:
      "部署 ADS（`npm run deploy:local`、切换 release、重启 `ads-web` / `ads-tg`）必须获得用户明确授权后才能执行。",
    category: "execution",
    severity: "approval_required",
    match: {
      tools: ["shell", "bash", "command"],
      commandPatterns: [
        "npm\\s+run\\s+deploy",
        "systemctl(\\s+--user)?\\s+(restart|start)\\s+[^\\n]*ads(-web|-tg)?\\b",
      ],
    },
  },
];

function parseTemplateRules(markdown: string): Array<{ title: string; body: string }> {
  const rules: Array<{ title: string; body: string }> = [];
  for (const rawLine of String(markdown ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^(\d+)[.、]\s*(.+)$/.exec(line);
    if (!match) continue;
    const body = match[2].trim();
    if (!body) continue;
    const separator = body.search(/[：:]/);
    const title = separator > 0 ? body.slice(0, separator).trim() : body.slice(0, 24).trim();
    rules.push({ title: title || `规则 ${match[1]}`, body });
  }
  return rules;
}

function severityLabel(severity: RuleSeverity): string {
  switch (severity) {
    case "blocked":
      return "blocked (无条件拒绝)";
    case "approval_required":
      return "approval_required (需用户明确授权)";
    case "required":
      return "required (必须满足)";
    default:
      return "advisory (建议)";
  }
}

export function renderGlobalRulesBlock(rules: GlobalRule[]): string {
  if (rules.length === 0) return "";
  const lines: string[] = [GLOBAL_RULES_OPEN_TAG];
  lines.push("以下规则由 ADS 全局规则库统一下发，对所有 channel 与 agent 生效。");
  for (const rule of rules) {
    lines.push("");
    lines.push(`- [${rule.category}/${severityLabel(rule.severity)}] ${rule.title}`);
    for (const bodyLine of rule.body.split(/\r?\n/)) {
      lines.push(`  ${bodyLine}`);
    }
  }
  lines.push("");
  lines.push("违反 blocked 或未获授权的 approval_required 规则时，必须立即停止并说明原因。");
  lines.push(GLOBAL_RULES_CLOSE_TAG);
  return lines.join("\n");
}

export function createGlobalRuleService(options: GlobalRuleServiceOptions = {}) {
  const logger = options.logger ?? createLogger("GlobalRules");
  const templateRulesPath =
    options.templateRulesPath ?? path.join(PROJECT_ROOT, "templates", "rules.md");

  let store: GlobalRuleStore | null = null;
  let storeFailureLogged = false;
  let cachedRender: RenderedGlobalRules | null = null;
  let cachedRevisionKey: string | null = null;

  const resolveStore = (): GlobalRuleStore | null => {
    if (store) return store;
    try {
      store = createGlobalRuleStore(options.db ?? getStateDatabase());
      storeFailureLogged = false;
      return store;
    } catch (error) {
      if (!storeFailureLogged) {
        logger.warn(
          `global rules database unavailable, falling back to read-only bootstrap rules: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        storeFailureLogged = true;
      }
      return null;
    }
  };

  const readTemplateRules = (): string => {
    try {
      return fs.readFileSync(templateRulesPath, "utf-8");
    } catch {
      return "";
    }
  };

  const hasSeeded = (db: DatabaseType): boolean => {
    const row = db
      .prepare("SELECT value FROM kv_state WHERE namespace = ? AND key = ? LIMIT 1")
      .get(SEED_NAMESPACE, SEED_KEY) as { value?: string } | undefined;
    return Boolean(row?.value);
  };

  const markSeeded = (db: DatabaseType): void => {
    db.prepare(
      `INSERT INTO kv_state (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(SEED_NAMESPACE, SEED_KEY, "1", Date.now());
  };

  /**
   * Import `templates/rules.md` on first start. Idempotent: it runs only when
   * the table is empty and the seed marker is absent, so an operator who
   * deliberately deleted every rule does not get them back.
   */
  const seedIfNeeded = (): number => {
    const activeStore = resolveStore();
    if (!activeStore) return 0;
    const db = options.db ?? getStateDatabase();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS kv_state (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(namespace, key)
        )
      `);
      if (hasSeeded(db) || activeStore.countRules() > 0) {
        return 0;
      }
      const parsed = parseTemplateRules(readTemplateRules());
      if (parsed.length === 0) {
        // No readable bootstrap file: seed nothing rather than inventing rules,
        // and stay unmarked so a later readable template still seeds.
        return 0;
      }
      let priority = 100;
      let seeded = 0;
      for (const rule of parsed) {
        const override = SEED_OVERRIDES.find((entry) => rule.body.includes(entry.marker));
        activeStore.saveRule({
          id: `rule-${randomUUID()}`,
          title: rule.title,
          body: rule.body,
          category: override?.category ?? "instruction",
          severity: override?.severity ?? "required",
          enabled: true,
          priority,
          updatedBy: "bootstrap",
          match: override?.match ?? null,
        });
        priority += 10;
        seeded += 1;
      }
      for (const extra of EXTRA_SEEDS) {
        activeStore.saveRule({
          id: `rule-${randomUUID()}`,
          title: extra.title,
          body: extra.body,
          category: extra.category,
          severity: extra.severity,
          enabled: true,
          priority,
          updatedBy: "bootstrap",
          match: extra.match ?? null,
        });
        priority += 10;
        seeded += 1;
      }
      markSeeded(db);
      cachedRevisionKey = null;
      if (seeded > 0) {
        logger.info(`seeded ${seeded} global rules from ${templateRulesPath}`);
      }
      return seeded;
    } catch (error) {
      logger.warn(
        `failed to seed global rules: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  };

  const listEnabledRules = (): GlobalRule[] => {
    const activeStore = resolveStore();
    if (!activeStore) return [];
    try {
      return activeStore.listEnabledRules();
    } catch (error) {
      logger.warn(
        `failed to read global rules: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  };

  const buildBootstrapRender = (): RenderedGlobalRules => {
    const content = readTemplateRules().trim();
    const text = content
      ? [
          GLOBAL_RULES_OPEN_TAG,
          "[degraded] 全局规则数据库不可用，以下为只读 bootstrap 规则。",
          content,
          GLOBAL_RULES_CLOSE_TAG,
        ].join("\n")
      : "";
    return {
      text,
      hash: crypto.createHash("sha1").update(text).digest("hex"),
      source: "bootstrap",
      degraded: true,
      ruleCount: content ? 1 : 0,
    };
  };

  /**
   * Render the block injected into every prompt. Cached by the store revision
   * so a rule edit in one process is picked up by the other on the next turn
   * without a restart.
   */
  const render = (): RenderedGlobalRules => {
    const activeStore = resolveStore();
    if (!activeStore) {
      return buildBootstrapRender();
    }
    try {
      const revision = activeStore.getRevision();
      const revisionKey = `${revision.count}:${revision.updatedAt}`;
      if (cachedRender && cachedRevisionKey === revisionKey) {
        return cachedRender;
      }
      const rules = activeStore.listEnabledRules();
      const text = renderGlobalRulesBlock(rules);
      const rendered: RenderedGlobalRules = {
        text,
        hash: crypto.createHash("sha1").update(text).digest("hex"),
        source: "database",
        degraded: false,
        ruleCount: rules.length,
      };
      cachedRender = rendered;
      cachedRevisionKey = revisionKey;
      return rendered;
    } catch (error) {
      logger.warn(
        `global rules render failed, degrading to bootstrap rules: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return buildBootstrapRender();
    }
  };

  const invalidate = (): void => {
    cachedRender = null;
    cachedRevisionKey = null;
  };

  return {
    seedIfNeeded,
    listEnabledRules,
    render,
    invalidate,
    getStore: resolveStore,
  };
}

export type GlobalRuleService = ReturnType<typeof createGlobalRuleService>;

let defaultService: GlobalRuleService | null = null;

export function getGlobalRuleService(): GlobalRuleService {
  if (!defaultService) {
    defaultService = createGlobalRuleService();
  }
  return defaultService;
}

/** Test hook: drop the process-wide service so the next call rebinds to a fresh database. */
export function resetGlobalRuleService(): void {
  defaultService = null;
}

export { parseTemplateRules };
