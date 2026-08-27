import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { listAgentSessions, listLinkedSessions } from "../../server/agents/sessions/catalog.js";
import {
  buildSessionTitle,
  extractUserFacingPrompt,
  truncatePreview,
} from "../../server/agents/sessions/promptPreview.js";
import { claudeProjectSlug } from "../../server/agents/sessions/sessionPaths.js";
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  normalizeSessionListLimit,
} from "../../server/agents/sessions/types.js";
import type { HistoryStore } from "../../server/utils/historyStore.js";

type LinkRow = {
  historyKey: string;
  agentId: string;
  providerSessionId: string;
  cwd?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  linkCount?: number;
};

function stubHistoryStore(args: {
  links: LinkRow[];
  entries?: Record<string, Array<{ role: string; text: string; ts: number }>>;
}): HistoryStore {
  return {
    listAgentSessionLinks: ({ agentId }: { agentId: string }) =>
      args.links.filter((link) => link.agentId === agentId),
    get: (sessionId: string) => args.entries?.[sessionId] ?? [],
  } as unknown as HistoryStore;
}

describe("agents/sessions/promptPreview", () => {
  it("recovers the user request from an ADS-composed prompt", () => {
    const composed = [
      "You are Codex (id: codex), the active ADS agent.",
      "<global_rules>never do bad things</global_rules>",
      "**用户请求（请直接回应以下内容，上面是背景指令）：**",
      "帮我修复登录超时的问题",
    ].join("\n");

    assert.equal(extractUserFacingPrompt(composed), "帮我修复登录超时的问题");
  });

  it("drops wrapped instruction blocks even without a request marker", () => {
    const composed = "<system-reminder>ignore me</system-reminder>\n真正的问题在这里";
    assert.equal(extractUserFacingPrompt(composed), "真正的问题在这里");
  });

  it("keeps the live request when a context-restore block precedes it", () => {
    const composed = [
      "[Context restore] Recent chat history (for reference only).",
      "User: 旧的问题",
      "",
      "---",
      "继续完成文档的输出",
    ].join("\n");

    assert.equal(extractUserFacingPrompt(composed), "继续完成文档的输出");
  });

  it("returns an empty string when nothing user-authored survives", () => {
    assert.equal(extractUserFacingPrompt("<INSTRUCTIONS>only rules</INSTRUCTIONS>"), "");
    assert.equal(extractUserFacingPrompt("   "), "");
  });

  it("falls through title candidates until one yields text", () => {
    assert.equal(buildSessionTitle([null, "<global_rules>x</global_rules>", "真实标题"]), "真实标题");
    assert.equal(buildSessionTitle([undefined, ""]), "");
  });

  it("truncates previews on character boundaries", () => {
    assert.equal(truncatePreview("abcdef", 3), "abc…");
    assert.equal(truncatePreview("abc", 3), "abc");
  });
});

describe("agents/sessions/sessionPaths", () => {
  it("derives the claude project slug from an absolute cwd", () => {
    assert.equal(claudeProjectSlug("/home/andy/repos/ads"), "-home-andy-repos-ads");
  });

  it("normalizes trailing slashes and dots in the slug", () => {
    assert.equal(claudeProjectSlug("/home/andy/repos/ads/"), "-home-andy-repos-ads");
    assert.equal(claudeProjectSlug("/home/andy/my.project"), "-home-andy-my-project");
  });
});

describe("agents/sessions/types", () => {
  it("clamps the list limit to a sane range", () => {
    assert.equal(normalizeSessionListLimit(undefined), 20);
    assert.equal(normalizeSessionListLimit(0), 20);
    assert.equal(normalizeSessionListLimit(5), 5);
    assert.equal(normalizeSessionListLimit(9999), 100);
  });

  it("round-trips a list cursor", () => {
    const encoded = encodeSessionListCursor({ providerCursor: "codex-page-2", offset: 40 });
    assert.deepEqual(decodeSessionListCursor(encoded), { providerCursor: "codex-page-2", offset: 40 });
  });
  it("restarts from the beginning rather than failing on a damaged cursor", () => {
    assert.deepEqual(decodeSessionListCursor(undefined), { offset: 0 });
    assert.deepEqual(decodeSessionListCursor("not-base64-json"), { offset: 0 });
    assert.deepEqual(decodeSessionListCursor(encodeSessionListCursor({ offset: -5 })), {
      providerCursor: undefined,
      offset: 0,
    });
  });
});

describe("agents/sessions/catalog", () => {
  it("prefers ADS history text over the raw provider transcript for previews", () => {
    const historyStore = stubHistoryStore({
      links: [
        {
          historyKey: "web:1",
          agentId: "claude",
          providerSessionId: "sess-a",
          cwd: "/repo",
          firstSeenAt: 1_000,
          lastSeenAt: 2_000,
        },
      ],
      entries: {
        "web:1": [
          { role: "user", text: "把导出改成流式", ts: 1_000 },
          { role: "assistant", text: "好的", ts: 1_100 },
        ],
      },
    });

    const refs = listLinkedSessions({ historyStore, agentId: "claude", cwd: "/repo" }).items;
    assert.equal(refs.length, 1);
    assert.equal(refs[0].title, "把导出改成流式");
    assert.equal(refs[0].messageCount, 2);
    assert.equal(refs[0].source, "ads_link");
    assert.equal(refs[0].linkedHistoryKey, "web:1");
  });

  it("excludes links recorded under an unrelated cwd", () => {
    const historyStore = stubHistoryStore({
      links: [
        {
          historyKey: "web:1",
          agentId: "codex",
          providerSessionId: "sess-a",
          cwd: "/other-project",
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
      ],
    });

    assert.equal(listLinkedSessions({ historyStore, agentId: "codex", cwd: "/repo" }).items.length, 0);
    assert.equal(
      listLinkedSessions({ historyStore, agentId: "codex", cwd: "/repo", includeAllCwds: true }).items.length,
      1,
    );
  });

  it("sorts by recency, marks the current session first, and applies the limit", async () => {
    const historyStore = stubHistoryStore({
      links: [
        { historyKey: "a", agentId: "gemini", providerSessionId: "old", cwd: "/repo", firstSeenAt: 1, lastSeenAt: 10 },
        { historyKey: "b", agentId: "gemini", providerSessionId: "new", cwd: "/repo", firstSeenAt: 2, lastSeenAt: 90 },
        { historyKey: "c", agentId: "gemini", providerSessionId: "cur", cwd: "/repo", firstSeenAt: 3, lastSeenAt: 50 },
      ],
    });

    const result = await listAgentSessions(
      { historyStore, currentSessionId: "cur" },
      { agentId: "gemini" as never, cwd: "/repo", limit: 2 },
    );

    assert.deepEqual(
      result.items.map((item) => item.sessionId),
      ["cur", "new"],
    );
    assert.equal(result.items[0].isCurrent, true);
    assert.equal(result.items[1].isCurrent, false);
  });

  it("filters by search term across title and session id", async () => {
    const historyStore = stubHistoryStore({
      links: [
        { historyKey: "a", agentId: "gemini", providerSessionId: "alpha", cwd: "/repo", firstSeenAt: 1, lastSeenAt: 10 },
        { historyKey: "b", agentId: "gemini", providerSessionId: "beta", cwd: "/repo", firstSeenAt: 2, lastSeenAt: 20 },
      ],
      entries: {
        a: [{ role: "user", text: "数据库迁移", ts: 1 }],
        b: [{ role: "user", text: "前端构建", ts: 2 }],
      },
    });

    const byTitle = await listAgentSessions(
      { historyStore },
      { agentId: "gemini" as never, cwd: "/repo", searchTerm: "迁移" },
    );
    assert.deepEqual(byTitle.items.map((item) => item.sessionId), ["alpha"]);

    const bySessionId = await listAgentSessions(
      { historyStore },
      { agentId: "gemini" as never, cwd: "/repo", searchTerm: "beta" },
    );
    assert.deepEqual(bySessionId.items.map((item) => item.sessionId), ["beta"]);
  });

  it("hides one-shot sessions and reports how many were withheld", async () => {
    const historyStore = stubHistoryStore({
      links: [
        { historyKey: "a", agentId: "gemini", providerSessionId: "oneshot", cwd: "/repo", firstSeenAt: 1, lastSeenAt: 30 },
        { historyKey: "b", agentId: "gemini", providerSessionId: "real", cwd: "/repo", firstSeenAt: 2, lastSeenAt: 20 },
      ],
      entries: {
        a: [{ role: "user", text: "继续", ts: 1 }],
        b: [
          { role: "user", text: "重构导出流程", ts: 2 },
          { role: "assistant", text: "好的", ts: 3 },
          { role: "user", text: "再补上测试", ts: 4 },
        ],
      },
    });

    const result = await listAgentSessions({ historyStore }, { agentId: "gemini" as never, cwd: "/repo" });
    assert.deepEqual(result.items.map((item) => item.sessionId), ["real"]);
    assert.equal(result.hidden?.singleTurn, 1);
  });

  it("reveals one-shot sessions when the caller opts into noise", async () => {
    const historyStore = stubHistoryStore({
      links: [
        { historyKey: "a", agentId: "gemini", providerSessionId: "oneshot", cwd: "/repo", firstSeenAt: 1, lastSeenAt: 30 },
      ],
      entries: { a: [{ role: "user", text: "继续", ts: 1 }] },
    });

    const hidden = await listAgentSessions({ historyStore }, { agentId: "gemini" as never, cwd: "/repo" });
    assert.equal(hidden.items.length, 0);

    const shown = await listAgentSessions(
      { historyStore },
      { agentId: "gemini" as never, cwd: "/repo", includeNoise: true },
    );
    assert.deepEqual(shown.items.map((item) => item.sessionId), ["oneshot"]);
  });

  it("keeps searching able to reach a one-shot session", async () => {
    const historyStore = stubHistoryStore({
      links: [
        { historyKey: "a", agentId: "gemini", providerSessionId: "oneshot", cwd: "/repo", firstSeenAt: 1, lastSeenAt: 30 },
      ],
      entries: { a: [{ role: "user", text: "排查磁盘告警", ts: 1 }] },
    });

    const result = await listAgentSessions(
      { historyStore },
      { agentId: "gemini" as never, cwd: "/repo", searchTerm: "磁盘" },
    );
    assert.deepEqual(result.items.map((item) => item.sessionId), ["oneshot"]);
  });

  it("never hides the session the orchestrator is attached to", async () => {
    const historyStore = stubHistoryStore({
      links: [
        { historyKey: "a", agentId: "gemini", providerSessionId: "cur", cwd: "/repo", firstSeenAt: 1, lastSeenAt: 30 },
      ],
      entries: { a: [{ role: "user", text: "继续", ts: 1 }] },
    });

    const result = await listAgentSessions(
      { historyStore, currentSessionId: "cur" },
      { agentId: "gemini" as never, cwd: "/repo" },
    );
    assert.deepEqual(result.items.map((item) => item.sessionId), ["cur"]);
  });

  it("collapses same-titled sessions onto the newest and counts the rest", async () => {
    const entries: Record<string, Array<{ role: string; text: string; ts: number }>> = {};
    const links: LinkRow[] = [];
    for (let index = 0; index < 4; index += 1) {
      const key = `dup-${index}`;
      links.push({
        historyKey: key,
        agentId: "gemini",
        providerSessionId: `sess-${index}`,
        cwd: "/repo",
        firstSeenAt: index,
        lastSeenAt: 100 + index,
      });
      // Two user turns each, so the one-shot filter cannot be what removes them.
      entries[key] = [
        { role: "user", text: "  继续 ", ts: index },
        { role: "assistant", text: "ok", ts: index },
        { role: "user", text: "继续", ts: index },
      ];
    }

    const result = await listAgentSessions({ historyStore: stubHistoryStore({ links, entries }) }, {
      agentId: "gemini" as never,
      cwd: "/repo",
    });

    assert.deepEqual(result.items.map((item) => item.sessionId), ["sess-3"]);
    assert.equal(result.items[0].duplicateCount, 4);
    assert.equal(result.hidden?.duplicates, 3);
  });

  it("keeps long-idle sessions selectable and unlabelled", async () => {
    // Age is not evidence that a rollout is gone, so the catalog must not rank,
    // mark, or withhold on it: an old session resumes exactly like a fresh one.
    const now = 10_000_000;
    const day = 24 * 60 * 60 * 1000;
    const links: LinkRow[] = [
      {
        historyKey: "fresh",
        agentId: "gemini",
        providerSessionId: "sess-fresh",
        cwd: "/repo",
        firstSeenAt: now - 60_000,
        lastSeenAt: now - 60_000,
      },
      {
        historyKey: "old",
        agentId: "gemini",
        providerSessionId: "sess-old",
        cwd: "/repo",
        firstSeenAt: now - day * 30,
        lastSeenAt: now - day * 30,
      },
    ];

    const result = await listAgentSessions(
      { historyStore: stubHistoryStore({ links }) },
      { agentId: "gemini" as never, cwd: "/repo" },
    );

    assert.equal(result.items.length, 2);
    assert.deepEqual(
      result.items.map((item) => item.sessionId),
      ["sess-fresh", "sess-old"],
    );
    for (const item of result.items) {
      assert.equal("stale" in item, false);
    }
  });

  it("offers only the newest provider session of a forked conversation", async () => {
    // One lane, three provider ids: what a CLI that forks on every resumed turn
    // leaves behind. Only the last one still holds the whole conversation.
    const links: LinkRow[] = [
      { historyKey: "lane-a", agentId: "claude", providerSessionId: "fork-1", cwd: "/repo", firstSeenAt: 1, lastSeenAt: 10 },
      { historyKey: "lane-a", agentId: "claude", providerSessionId: "fork-2", cwd: "/repo", firstSeenAt: 2, lastSeenAt: 20 },
      { historyKey: "lane-a", agentId: "claude", providerSessionId: "fork-3", cwd: "/repo", firstSeenAt: 3, lastSeenAt: 30 },
      { historyKey: "lane-b", agentId: "claude", providerSessionId: "solo", cwd: "/repo", firstSeenAt: 4, lastSeenAt: 25 },
    ];
    const historyStore = stubHistoryStore({ links });

    const linked = listLinkedSessions({ historyStore, agentId: "claude", cwd: "/repo" });
    assert.deepEqual(
      linked.items.map((item) => item.sessionId).sort(),
      ["fork-3", "solo"],
    );
    assert.equal(linked.items.find((item) => item.sessionId === "fork-3")?.forkCount, 3);
    assert.equal(linked.items.find((item) => item.sessionId === "solo")?.forkCount, 1);
    assert.equal(linked.forksCollapsed, 2);

    const result = await listAgentSessions(
      { historyStore },
      { agentId: "claude" as never, cwd: "/repo" },
    );
    assert.deepEqual(result.items.map((item) => item.sessionId), ["fork-3", "solo"]);
    assert.equal(result.hidden?.forks, 2);
  });

  it("trusts the store's own fork grouping when it supplies a count", () => {
    const historyStore = stubHistoryStore({
      links: [
        {
          historyKey: "lane-a",
          agentId: "claude",
          providerSessionId: "newest",
          cwd: "/repo",
          firstSeenAt: 1,
          lastSeenAt: 99,
          linkCount: 53,
        },
      ],
    });

    const linked = listLinkedSessions({ historyStore, agentId: "claude", cwd: "/repo" });
    assert.equal(linked.items.length, 1);
    assert.equal(linked.items[0].forkCount, 53);
    assert.equal(linked.forksCollapsed, 52);
  });
});
