/**
 * Static check for #377 slice 5: newly introduced legacy lane terminology
 * (`advisor` / `planner` / lane-context `worker`) must not appear in
 * production sources unless the file is explicitly classified in
 * ALLOWED_LEGACY_TERMINOLOGY below.
 *
 * Every entry carries one of the four categories defined by #377:
 *   - compatibility     legacy values parsed on a read path
 *   - persistence-key   a value baked into an on-disk / persisted identifier
 *   - protocol-field    a value carried on the wire or in a DOM/CSS contract
 *   - historical-record a description of a past state (migrations, fixtures)
 *
 * A legacy term that is none of those is a defect and has to be renamed, so no
 * "defect" category exists here on purpose. Each entry also pins the number of
 * legacy lines the file is allowed to keep, so putting a legacy reference on a
 * new line inside an already-classified file fails just as loudly as adding a
 * new file. Raising `legacyLines` is therefore a deliberate, reviewable act and
 * is the mechanism for scheduling a follow-up rename.
 *
 * Known limits, stated rather than papered over:
 *   - the budget counts matching LINES, not occurrences, so a second legacy
 *     reference appended to a line that already matched is not detected;
 *   - `worker` is only recognised in an enumerated set of lane-denoting
 *     compounds, so a new `workerFoo` identifier is not caught. That is
 *     deliberate: `workerId` in the prompt queue is a generic job-owner id.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const SCAN_ROOTS = ["server", "client/src", "shared", "scripts"] as const;

/**
 * Match `worker` only in lane-denoting positions so unrelated infrastructure
 * uses (service worker bootstrap, vitest `maxWorkers`, ...) are not flagged.
 */
const LEGACY_PATTERN =
  /\b(?:advisor|planner)\b|(["'`])worker\1|\bweb-worker\b|\blane-tab-worker\b|\bworkerHistoryStore\b|\bworkerSessionManager\b|\bworkerCodexModel\b|\bworkerSandboxMode\b|\bworkerPromptHandler\b|\bWORKER_[A-Z_]+\b|\bADS_(ADVISOR|PLANNER)_[A-Z_]+\b|\bgetAdvisorWorkspaceLock\b|\badvisor(HistoryStore|SessionManager|CodexModel|SandboxMode)\b|\bchatHost--advisor\b|\blanePanelsTrack--worker\b|\bdata-(worker|advisor)-/i;

interface LegacyAllowance {
  /** Why the remaining occurrences in this file are acceptable. */
  readonly reason: string;
  /** How many matching lines the file is currently allowed to keep. */
  readonly legacyLines: number;
}

const ALLOWED_LEGACY_TERMINOLOGY: Record<string, LegacyAllowance> = {
  // ---- contract / compatibility tables ----
  "shared/terminology.ts": {
    reason: "compatibility: the canonical LEGACY_LANE_ALIASES / LEGACY_ROLE_PROFILE_ALIASES tables",
    legacyLines: 6,
  },
  "server/web/server/ws/session.ts": {
    reason:
      "compatibility + persistence-key: normalizes advisor/planner/acopilot onto the stable ADVISOR_CHAT_SESSION_ID",
    legacyLines: 6,
  },
  "client/src/lib/laneIds.ts": {
    reason: "compatibility: LEGACY_ADVISOR_LANE_ID re-export",
    legacyLines: 1,
  },
  "client/src/lib/preferencesStore.ts": {
    reason: "compatibility: reads legacy lane spellings out of localStorage preferences",
    legacyLines: 14,
  },
  "client/src/lib/mobileWorkspacePreferences.ts": {
    reason: "compatibility: reads legacy lane spellings from mobile workspace preferences",
    legacyLines: 2,
  },
  "server/state/lanePromptStore.ts": {
    reason: "compatibility: accepts legacy lane ids on read",
    legacyLines: 1,
  },
  "server/state/lanePromptDefaults.ts": {
    reason: "compatibility: documents that legacy spellings are rejected here",
    legacyLines: 1,
  },
  "server/web/server/api/routes/lanePrompts.ts": {
    reason: "compatibility: accepts legacy lane ids on read",
    legacyLines: 1,
  },
  "server/web/server/api/routes/roleProfiles.ts": {
    reason: "compatibility: maps a stored `worker` role profile onto developer",
    legacyLines: 1,
  },
  "client/src/app/controller.ts": {
    reason: "compatibility: comment describing the legacy wire value",
    legacyLines: 1,
  },
  "client/src/app/chat.ts": {
    reason: "compatibility: falls back to the legacy planner outbox key on read",
    legacyLines: 2,
  },
  "client/src/app/laneActions.ts": {
    reason: "compatibility: local variable and breadcrumb names for the acopilot runtime",
    legacyLines: 7,
  },

  // ---- persistence keys (must not be renamed in place) ----
  "server/web/server/start/webLaneResources.ts": {
    reason: "persistence-key: WEB_WORKER_NAMESPACE / WEB_ADVISOR_NAMESPACE history namespaces",
    legacyLines: 20,
  },
  "server/web/server/startWebServer.ts": {
    reason: "persistence-key: advisor/worker lane runtime wiring keyed on the history namespaces",
    legacyLines: 17,
  },
  "server/web/server/ws/laneResources.ts": {
    reason: "persistence-key: selects advisor vs worker history and session stores by lane",
    legacyLines: 8,
  },
  "server/web/server/ws/deps.ts": {
    reason: "persistence-key: advisorSessionManager / advisorHistoryStore dependency names",
    legacyLines: 5,
  },
  "server/web/server/ws/handlePrompt.ts": {
    reason: "persistence-key: workerPromptHandler naming for the actions lane runtime",
    legacyLines: 4,
  },
  "server/web/server/api/routes/sync.ts": {
    reason: "persistence-key: resolveSyncNamespace selects the advisor/worker history stores",
    legacyLines: 5,
  },
  "server/web/server/api/handler.ts": {
    reason: "persistence-key: advisor/worker history store dependency names",
    legacyLines: 4,
  },
  "server/sessions/sessionManager.ts": {
    reason: "persistence-key: 'web-advisor' / 'web-worker' agent allowlist namespaces",
    legacyLines: 3,
  },
  "server/utils/historyStore.ts": {
    reason: "persistence-key: history keys embed '::advisor' with a legacy '::planner' fallback",
    legacyLines: 7,
  },
  "client/src/App.vue": {
    reason:
      "persistence-key + protocol-field: localStorage composer stash keys and data-* DOM hooks",
    legacyLines: 11,
  },

  // ---- protocol / DOM and CSS contracts ----
  "client/src/lib/laneWire.ts": {
    reason: "protocol-field: WireChatSessionId is the on-the-wire chat session vocabulary",
    legacyLines: 7,
  },
  "client/src/components/MainChat.css": {
    reason: "protocol-field: .chatHost--advisor CSS class referenced from App.vue",
    legacyLines: 5,
  },
  "client/src/App.css": {
    reason: "protocol-field: .lanePanelsTrack--worker CSS class referenced from App.vue",
    legacyLines: 1,
  },
  "client/src/app/projectsWs/webSocketActions.ts": {
    reason: "protocol-field: developer-facing diag alert text mentions the advisor runtime",
    legacyLines: 1,
  },

  // ---- historical record ----
  "server/state/schemaMigrations.ts": {
    reason: "historical-record: SQL CASE WHEN mapping persisted legacy values onto canonical ones",
    legacyLines: 10,
  },
  "server/config.ts": {
    reason: "historical-record: ADS_ADVISOR_* / ADS_PLANNER_* env vars kept for compatibility",
    legacyLines: 3,
  },
  "scripts/test-chat-browser.js": {
    reason: "historical-record: browser test fixture strings predate the rename",
    legacyLines: 14,
  },
  "scripts/lib/chat-browser-server.js": {
    reason: "historical-record: browser test fixture namespaces predate the rename",
    legacyLines: 13,
  },
  "scripts/lib/chat-browser-history.js": {
    reason: "historical-record: browser test fixture strings predate the rename",
    legacyLines: 5,
  },
  "scripts/lib/chat-browser-local-first.js": {
    reason: "historical-record: browser test fixture strings predate the rename",
    legacyLines: 4,
  },
  "scripts/lib/chat-browser-post-send.js": {
    reason: "historical-record: browser test fixture strings predate the rename",
    legacyLines: 10,
  },
  "scripts/tmp-repro-ios3.mjs": {
    reason: "historical-record: throwaway repro script, slated for deletion in a follow-up",
    legacyLines: 22,
  },
  "scripts/tmp-repro-wrap.mjs": {
    reason: "historical-record: throwaway repro script, slated for deletion in a follow-up",
    legacyLines: 3,
  },
};

/**
 * camelCase compounds that embed a legacy lane term, matched case-sensitively.
 *
 * These cannot live in LEGACY_PATTERN: that pattern carries the `i` flag, which
 * would make its `[A-Z]` boundary match lowercase too and flag unrelated words
 * such as "advisory". Requiring a genuine case transition keeps "advisory" and
 * "workerId" out while catching advisorHandler / advisorConfig / isAdvisorLane.
 *
 * Deliberately scoped to `advisor`: a bare `worker` prefix rule would flag
 * `workerId` in the prompt queue, which is a generic job-owner id and has
 * nothing to do with the Actions lane.
 *
 * Every clause requires a further capital letter, so `Advisory` and `advisors`
 * stay out. A bare `\bAdvisor\b` clause is omitted on purpose: it only ever
 * matches English prose such as the "Advisor reply:" fixture strings, which
 * would inflate the budgets without flagging a single real identifier.
 */
const LEGACY_CAMEL_PATTERN = /\badvisor[A-Z]\w*|\b[a-z]+Advisor[A-Z]\w*|\bAdvisor[A-Z]\w*/;

/** Directories that never contain hand-written lane code. */
const IGNORED_DIRECTORIES = new Set([".git", ".worktrees", "coverage", "dist", "node_modules"]);

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".vue"]);

/**
 * Walk the working tree rather than `git ls-files`: the point of this check is
 * to fail on terminology the moment it is typed, before the file is staged.
 */
function listSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(relativePath.split(path.sep).join("/"));
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return found.sort();
}

function isScannable(file: string): boolean {
  if (file.endsWith(".md")) return false;
  if (file.endsWith(".test.ts")) return false;
  // Service worker bootstrap and the vitest worker pool config are not lane code.
  if (file === "client/public/registerSW.js") return false;
  if (file === "client/vitest.config.ts") return false;
  return true;
}

function findLegacyTerminology(file: string): number[] {
  const hits: number[] = [];
  readFileSync(path.join(REPO_ROOT, file), "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (LEGACY_PATTERN.test(line) || LEGACY_CAMEL_PATTERN.test(line)) hits.push(index + 1);
    });
  return hits;
}

test("no unqualified legacy lane terminology in production sources", () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    if (!isScannable(file)) continue;
    if (ALLOWED_LEGACY_TERMINOLOGY[file]) continue;
    const hits = findLegacyTerminology(file);
    if (hits.length > 0) offenders.push(`${file}:${hits.join(",")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "Legacy advisor/planner/worker terminology found outside the allowlist. " +
      "Either rename to the canonical vocabulary (acopilot/actions) or add a " +
      "classified entry to ALLOWED_LEGACY_TERMINOLOGY.",
  );
});

test("classified files keep exactly the legacy references they declared", () => {
  const drifted: string[] = [];
  for (const [file, allowance] of Object.entries(ALLOWED_LEGACY_TERMINOLOGY)) {
    const actual = findLegacyTerminology(file).length;
    if (actual !== allowance.legacyLines) {
      drifted.push(`${file}: expected ${allowance.legacyLines} legacy lines, found ${actual}`);
    }
  }
  assert.deepEqual(
    drifted,
    [],
    "A classified file gained or lost legacy references. Raise legacyLines only " +
      "alongside a justification, or rename the references and drop the entry.",
  );
});
