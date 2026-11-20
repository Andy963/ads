import { describe, expect, it } from "vitest";

import {
  createPullRequestFirstPageCache,
  pullRequestCacheKey,
  type PullRequestCacheStore,
  type PullRequestFirstPageRecord,
} from "../lib/pullRequestCache";
import type { PullRequestSummary } from "../../../ts-server/shared/pullRequests.js";

class MemoryStore implements PullRequestCacheStore {
  records = new Map<string, PullRequestFirstPageRecord>();

  async get(key: string): Promise<PullRequestFirstPageRecord | null> {
    return this.records.get(key) ?? null;
  }

  async put(record: PullRequestFirstPageRecord): Promise<void> {
    this.records.set(record.key, structuredClone(record));
  }

  async list(): Promise<PullRequestFirstPageRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.records.delete(key);
  }
}

function summary(number: number, title = `PR ${number}`): PullRequestSummary {
  return {
    number,
    repository: "Andy963/ads",
    title,
    url: `https://github.com/Andy963/ads/pull/${number}`,
    state: "open",
    isDraft: false,
    author: "andy",
    updatedAt: "2026-11-20T10:00:00Z",
    createdAt: "2026-11-19T10:00:00Z",
    labels: [{ name: "enhancement", color: "a2eeef" }],
    checks: "passing",
    additions: 4,
    deletions: 2,
    headRefName: "feature/pr-view",
    baseRefName: "dev",
  };
}

const filters = { state: "open", involvement: "all", labels: ["enhancement"], author: "", checks: "all" };

describe("pull request first-page cache", () => {
  it("restores a scoped first page and excludes transient fields", async () => {
    const store = new MemoryStore();
    let now = 1_000;
    const cache = createPullRequestFirstPageCache({ store, now: () => now });
    await cache.save("p1", filters, [summary(42)], 900);

    const restored = await cache.load("p1", filters);
    expect(restored?.items.map((item) => item.number)).toEqual([42]);
    expect(Object.keys(restored ?? {}).sort()).toEqual([
      "bytes", "fetchedAt", "filters", "items", "key", "projectId", "storedAt",
    ]);
    expect(restored).not.toHaveProperty("nextCursor");
    expect(restored).not.toHaveProperty("error");

    expect(await cache.load("p2", filters)).toBeNull();
    expect(await cache.load("p1", { ...filters, state: "closed" })).toBeNull();
    expect(pullRequestCacheKey("p1", filters)).not.toBe(pullRequestCacheKey("p2", filters));
    now += 1;
  });

  it("drops records after the configured age", async () => {
    const store = new MemoryStore();
    let now = 1_000;
    const cache = createPullRequestFirstPageCache({ store, now: () => now, maxAgeMs: 100 });
    await cache.save("p1", filters, [summary(42)], now);
    expect(await cache.load("p1", filters)).not.toBeNull();

    now += 101;
    expect(await cache.load("p1", filters)).toBeNull();
    expect(store.records.size).toBe(0);
  });

  it("evicts the oldest scope beyond entry and byte limits", async () => {
    const store = new MemoryStore();
    let now = 1_000;
    const cache = createPullRequestFirstPageCache({ store, now: () => now, maxEntries: 2, maxBytes: 100_000 });
    await cache.save("p1", filters, [summary(1)], now);
    now += 1;
    await cache.save("p2", filters, [summary(2)], now);
    now += 1;
    await cache.save("p3", filters, [summary(3)], now);

    expect(await cache.load("p1", filters)).toBeNull();
    expect(await cache.load("p2", filters)).not.toBeNull();
    expect(await cache.load("p3", filters)).not.toBeNull();
  });

  it("rejects oversized payloads and can clear a project", async () => {
    const store = new MemoryStore();
    let now = 1_000;
    const cache = createPullRequestFirstPageCache({ store, now: () => now, maxBytes: 80 });
    await cache.save("p1", filters, [summary(42, "x".repeat(200))], now);
    expect(store.records.size).toBe(0);

    now += 1;
    const larger = createPullRequestFirstPageCache({ store, now: () => now });
    await larger.save("p1", filters, [summary(1)], now);
    await larger.save("p2", filters, [summary(2)], now);
    await larger.clearProject("p1");
    expect(await larger.load("p1", filters)).toBeNull();
    expect(await larger.load("p2", filters)).not.toBeNull();
  });
});
