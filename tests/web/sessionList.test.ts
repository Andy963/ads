import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  handleSessionListMessage,
  parseSessionListRequest,
} from "../../server/web/server/ws/handleSessionList.js";
import type { HistoryStore } from "../../server/utils/historyStore.js";

const silentLogger = { info: () => {}, warn: () => {} };

function stubHistoryStore(links: Array<Record<string, unknown>>): HistoryStore {
  return {
    listAgentSessionLinks: () => links,
    get: () => [],
  } as unknown as HistoryStore;
}

describe("web/ws/handleSessionList", () => {
  it("defaults the limit and treats blank fields as absent", () => {
    assert.deepEqual(parseSessionListRequest(undefined), {});
    assert.deepEqual(parseSessionListRequest({ agentId: "  ", search: "  ", cursor: "  " }), {
      agentId: undefined,
      limit: 20,
      search: undefined,
      includeAllCwds: false,
      includeNoise: false,
      cursor: undefined,
    });
  });

  it("clamps an oversized limit and keeps explicit flags", () => {
    assert.deepEqual(
      parseSessionListRequest({
        agentId: "claude",
        limit: 5000,
        includeAllCwds: true,
        includeNoise: true,
        cursor: "opaque-token",
      }),
      {
        agentId: "claude",
        limit: 100,
        search: undefined,
        includeAllCwds: true,
        includeNoise: true,
        cursor: "opaque-token",
      },
    );
  });

  it("answers with the active agent when the request omits one", async () => {
    const sent: unknown[] = [];
    await handleSessionListMessage({
      payload: {},
      historyStore: stubHistoryStore([
        {
          historyKey: "h1",
          agentId: "gemini",
          providerSessionId: "sess-1",
          cwd: "/repo",
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
      ]),
      currentCwd: "/repo",
      activeAgentId: "gemini" as never,
      currentSessionId: "sess-1",
      sendJson: (payload) => sent.push(payload),
      logger: silentLogger,
    });

    assert.equal(sent.length, 1);
    const response = sent[0] as { type: string; agentId: string; items: Array<{ sessionId: string; isCurrent: boolean }> };
    assert.equal(response.type, "session_list_result");
    assert.equal(response.agentId, "gemini");
    assert.deepEqual(response.items.map((item) => item.sessionId), ["sess-1"]);
    assert.equal(response.items[0].isCurrent, true);
  });

  it("reports an empty list with an error instead of throwing", async () => {
    const sent: unknown[] = [];
    await handleSessionListMessage({
      payload: {},
      historyStore: {
        listAgentSessionLinks: () => {
          throw new Error("db is gone");
        },
      } as unknown as HistoryStore,
      currentCwd: "/repo",
      activeAgentId: "codex" as never,
      sendJson: (payload) => sent.push(payload),
      logger: silentLogger,
    });

    const response = sent[0] as { type: string; items: unknown[]; error?: string };
    assert.equal(response.type, "session_list_result");
    assert.deepEqual(response.items, []);
    assert.match(String(response.error), /db is gone/);
  });

  it("pages a long list and marks the continuation as appended", async () => {
    const links = Array.from({ length: 25 }, (_, index) => ({
      historyKey: `h${index}`,
      agentId: "gemini",
      providerSessionId: `sess-${index}`,
      cwd: "/repo",
      firstSeenAt: index,
      lastSeenAt: index + 1,
    }));

    const firstPage: unknown[] = [];
    await handleSessionListMessage({
      payload: {},
      historyStore: stubHistoryStore(links),
      currentCwd: "/repo",
      activeAgentId: "gemini" as never,
      sendJson: (payload) => firstPage.push(payload),
      logger: silentLogger,
    });

    const first = firstPage[0] as { items: unknown[]; nextCursor?: string; appended: boolean };
    assert.equal(first.items.length, 20);
    assert.equal(first.appended, false);
    assert.ok(first.nextCursor, "a 25-row list must offer a continuation");

    const secondPage: unknown[] = [];
    await handleSessionListMessage({
      payload: { cursor: first.nextCursor },
      historyStore: stubHistoryStore(links),
      currentCwd: "/repo",
      activeAgentId: "gemini" as never,
      sendJson: (payload) => secondPage.push(payload),
      logger: silentLogger,
    });

    const second = secondPage[0] as {
      items: Array<{ sessionId: string }>;
      nextCursor?: string;
      appended: boolean;
    };
    assert.equal(second.items.length, 5);
    assert.equal(second.appended, true);
    assert.equal(second.nextCursor, undefined);
    // Newest first, so page two holds the five oldest links.
    assert.deepEqual(
      second.items.map((item) => item.sessionId),
      ["sess-4", "sess-3", "sess-2", "sess-1", "sess-0"],
    );
  });
});
