import type { HistoryStore } from "../../utils/historyStore.js";
import { areSessionCwdsCompatible } from "../../telegram/utils/sessionState.js";

import { listCodexSessions } from "./codexSessionSource.js";
import { buildSessionTitle, truncatePreview } from "./promptPreview.js";
import type { AgentSessionListQuery, AgentSessionListResult, AgentSessionRef } from "./types.js";
import { decodeSessionListCursor, encodeSessionListCursor, normalizeSessionListLimit } from "./types.js";

/** ADS-linked sessions are the most reliable candidates, so they are read generously. */
const LINK_SCAN_LIMIT = 200;

function titleFromHistory(
  historyStore: HistoryStore | undefined,
  historyKey: string,
): { title?: string; preview?: string; messageCount?: number; userTurns?: number } {
  const entries = historyStore?.get(historyKey) ?? [];
  if (!entries.length) {
    return {};
  }
  const firstUser = entries.find((entry) => entry.role === "user");
  const title = buildSessionTitle([firstUser?.text]);
  return {
    title: title || undefined,
    preview: firstUser ? truncatePreview(firstUser.text) : undefined,
    messageCount: entries.length,
    userTurns: entries.filter((entry) => entry.role === "user").length,
  };
}

/**
 * Sessions ADS itself started, recovered from `history_session_links`. These
 * carry an ADS history key, which yields a far better preview than the raw
 * provider transcript (whose first turn is the injected ADS preamble).
 *
 * Collapsed to the newest provider session per conversation. A CLI that forks a
 * fresh session id on each resumed turn leaves a chain of ids behind for one
 * lane, and every id but the last is strictly superseded: resuming an older fork
 * would drop the turns that came after it. The store already groups this way;
 * the pass here also covers a non-SQLite store.
 */
export function listLinkedSessions(args: {
  historyStore?: HistoryStore;
  agentId: string;
  cwd: string;
  includeAllCwds?: boolean;
}): { items: AgentSessionRef[]; forksCollapsed: number } {
  const links = args.historyStore?.listAgentSessionLinks({ agentId: args.agentId, limit: LINK_SCAN_LIMIT }) ?? [];
  const newestByLane = new Map<string, { link: (typeof links)[number]; forkCount: number }>();
  for (const link of links) {
    if (!args.includeAllCwds && !areSessionCwdsCompatible(link.cwd, args.cwd)) {
      continue;
    }
    const existing = newestByLane.get(link.historyKey);
    const forkCount = (existing?.forkCount ?? 0) + (link.linkCount ?? 1);
    newestByLane.set(link.historyKey, {
      // Ties keep the earlier row, which is the newer one: the store yields
      // rows newest-first.
      link: existing && existing.link.lastSeenAt >= link.lastSeenAt ? existing.link : link,
      forkCount,
    });
  }

  const refs: AgentSessionRef[] = [];
  let forksCollapsed = 0;
  for (const { link, forkCount } of newestByLane.values()) {
    forksCollapsed += Math.max(0, forkCount - 1);
    const enriched = titleFromHistory(args.historyStore, link.historyKey);
    refs.push({
      agentId: args.agentId as AgentSessionRef["agentId"],
      sessionId: link.providerSessionId,
      cwd: link.cwd,
      title: enriched.title,
      preview: enriched.preview,
      messageCount: enriched.messageCount,
      userTurns: enriched.userTurns,
      singleTurn: enriched.userTurns === undefined ? undefined : enriched.userTurns < 2,
      forkCount,
      createdAt: link.firstSeenAt,
      updatedAt: link.lastSeenAt,
      source: "ads_link",
      linkedHistoryKey: link.historyKey,
    });
  }
  return { items: refs, forksCollapsed };
}

/**
 * `false` is authoritative: one source having proven a second user turn outweighs
 * another source that only saw one.
 */
function mergeSingleTurn(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  if (a === false || b === false) {
    return false;
  }
  if (a === true || b === true) {
    return true;
  }
  return undefined;
}

/**
 * Merge two ordered lists, preferring the first list's entry for a session id
 * but filling missing display fields from the second.
 */
function mergeById(primary: AgentSessionRef[], secondary: AgentSessionRef[]): AgentSessionRef[] {
  const byId = new Map<string, AgentSessionRef>();
  for (const ref of primary) {
    byId.set(ref.sessionId, ref);
  }
  for (const ref of secondary) {
    const existing = byId.get(ref.sessionId);
    if (!existing) {
      byId.set(ref.sessionId, ref);
      continue;
    }
    byId.set(ref.sessionId, {
      ...existing,
      title: existing.title ?? ref.title,
      preview: existing.preview ?? ref.preview,
      cwd: existing.cwd ?? ref.cwd,
      messageCount: existing.messageCount ?? ref.messageCount,
      userTurns: Math.max(existing.userTurns ?? 0, ref.userTurns ?? 0) || undefined,
      singleTurn: mergeSingleTurn(existing.singleTurn, ref.singleTurn),
      createdAt: existing.createdAt ?? ref.createdAt,
      updatedAt: Math.max(existing.updatedAt, ref.updatedAt),
    });
  }
  return Array.from(byId.values());
}

/**
 * Group key for near-duplicate detection. Auto-continue bursts produce many
 * distinct sessions whose only user turn is the same generic prompt, so titles
 * collide exactly rather than approximately.
 */
function duplicateKey(ref: AgentSessionRef): string {
  const title = String(ref.title ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
  return title ? `t:${title}` : `id:${ref.sessionId}`;
}

/**
 * Keep the newest entry of each title group and record how many it stands for.
 * Input must already be sorted newest-first.
 */
function collapseDuplicates(refs: AgentSessionRef[]): { items: AgentSessionRef[]; collapsed: number } {
  const kept = new Map<string, AgentSessionRef>();
  let collapsed = 0;
  for (const ref of refs) {
    const key = duplicateKey(ref);
    const existing = kept.get(key);
    if (!existing) {
      kept.set(key, ref);
      continue;
    }
    existing.duplicateCount = (existing.duplicateCount ?? 1) + 1;
    collapsed += 1;
  }
  return { items: Array.from(kept.values()), collapsed };
}

function matchesSearch(ref: AgentSessionRef, searchTerm?: string): boolean {
  const needle = String(searchTerm ?? "").trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return `${ref.title ?? ""} ${ref.preview ?? ""} ${ref.sessionId}`.toLowerCase().includes(needle);
}

export interface AgentSessionCatalogDeps {
  /**
   * Optional: the Telegram channel records no session links, so it lists from
   * the provider sources alone.
   */
  historyStore?: HistoryStore;
  /** Session id the active orchestrator is already attached to, if any. */
  currentSessionId?: string | null;
}

/**
 * Unified view over provider-native session stores and ADS's own link table.
 *
 * Ordering is by last activity; provider-sourced entries win on metadata
 * freshness while ADS-linked entries win on preview quality, so the two are
 * merged rather than concatenated.
 *
 * Paging is driven by `query.cursor` / `result.nextCursor`; see
 * `SessionListCursor` in ./types.ts for why a provider cursor alone is not enough.
 */
export async function listAgentSessions(
  deps: AgentSessionCatalogDeps,
  query: AgentSessionListQuery,
): Promise<AgentSessionListResult> {
  const limit = normalizeSessionListLimit(query.limit);
  const position = decodeSessionListCursor(query.cursor);
  const degraded: string[] = [];

  // ADS-linked rows describe the whole link table, not one provider page, so
  // they belong to the first provider page only. Repeating them after the
  // provider cursor advances would show the same sessions on every page.
  const linked = position.providerCursor
    ? { items: [], forksCollapsed: 0 }
    : listLinkedSessions({
        historyStore: deps.historyStore,
        agentId: query.agentId,
        cwd: query.cwd,
        includeAllCwds: query.includeAllCwds,
      });

  let providerItems: AgentSessionRef[] = [];
  let providerCursor: string | undefined;
  if (query.agentId === "codex") {
    const result = await listCodexSessions({
      cwd: query.cwd,
      limit,
      searchTerm: query.searchTerm,
      cursor: position.providerCursor,
    });
    providerItems = result.items;
    providerCursor = result.nextCursor;
    if (result.degraded) {
      degraded.push(result.degraded);
    }
  }

  // ADS-linked entries are primary: their previews come from real user text.
  const ranked = mergeById(linked.items, providerItems)
    .filter((ref) => matchesSearch(ref, query.searchTerm))
    .filter((ref) => query.includeAllCwds || areSessionCwdsCompatible(ref.cwd, query.cwd))
    .map((ref) => ({
      ...ref,
      isCurrent: Boolean(deps.currentSessionId && ref.sessionId === deps.currentSessionId),
    }))
    .sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) {
        return a.isCurrent ? -1 : 1;
      }
      return b.updatedAt - a.updatedAt;
    });

  // An explicit search is a targeted query: withholding matches from it would be
  // worse than the noise the filter exists to suppress.
  const suppressNoise = !query.includeNoise && !String(query.searchTerm ?? "").trim();

  // One-shot sessions carry a single prompt answered once, so resuming one gains
  // nothing; an auto-continue burst can produce dozens and crowd out real work.
  // The session currently attached is never hidden.
  const substantive = suppressNoise
    ? ranked.filter((ref) => ref.isCurrent || ref.singleTurn !== true)
    : ranked;
  const hiddenSingleTurn = ranked.length - substantive.length;

  const { items: deduped, collapsed } = suppressNoise
    ? collapseDuplicates(substantive)
    : { items: substantive, collapsed: 0 };

  const page = deduped.slice(position.offset, position.offset + limit);
  const consumed = position.offset + page.length;

  const result: AgentSessionListResult = { items: page };
  if (consumed < deduped.length) {
    // More rows are already in hand from this provider page.
    result.nextCursor = encodeSessionListCursor({ providerCursor: position.providerCursor, offset: consumed });
  } else if (providerCursor) {
    result.nextCursor = encodeSessionListCursor({ providerCursor, offset: 0 });
  }
  if (degraded.length > 0) {
    result.degraded = degraded;
  }
  if (hiddenSingleTurn > 0 || collapsed > 0 || linked.forksCollapsed > 0) {
    result.hidden = { singleTurn: hiddenSingleTurn, duplicates: collapsed, forks: linked.forksCollapsed };
  }
  return result;
}
