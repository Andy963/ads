import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import type { PullRequestDetail, PullRequestSummary } from "../shared/pullRequests.js";

let listImpl: (url: string) => Promise<unknown> = async () => ({ items: [], nextCursor: null, partial: false, fetchedAt: 1 });
let detailImpl: (projectId: string, number: number) => Promise<unknown> = async () => ({ item: null, error: "missing", fetchedAt: 1 });
let cachedRecord: unknown = null;
const savedPages: unknown[] = [];

vi.mock("../api/pullRequests", () => ({
  fetchPullRequests: (query: unknown, _signal?: AbortSignal) => listImpl(queryToUrl(query)),
  fetchPullRequestDetail: (projectId: string, number: number) => detailImpl(projectId, number),
}));

vi.mock("../lib/pullRequestCache", () => ({
  getPullRequestFirstPageCache: () => ({
    load: async () => cachedRecord,
    save: async (_projectId: string, _filters: unknown, items: unknown, fetchedAt: number) => {
      savedPages.push({ items, fetchedAt });
    },
    clearProject: async () => undefined,
  }),
}));

function queryToUrl(query: Record<string, unknown>): string {
  return JSON.stringify(query);
}

function summary(number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number,
    repository: "Andy963/ads",
    title: `PR ${number}`,
    url: `https://github.com/Andy963/ads/pull/${number}`,
    state: "open",
    isDraft: false,
    author: "andy",
    updatedAt: "2026-11-20T10:00:00Z",
    createdAt: "2026-11-19T10:00:00Z",
    labels: [{ name: "enhancement", color: "a2eeef" }],
    checks: "passing",
    additions: 7,
    deletions: 2,
    headRefName: "feature/prs",
    baseRefName: "dev",
    ...overrides,
  };
}

async function mountWorkspace() {
  const PullRequestsWorkspace = (await import("../components/PullRequestsWorkspace.vue")).default;
  const wrapper = mount(PullRequestsWorkspace, { props: { projectId: "p1", active: true } });
  await flushPromises();
  return wrapper;
}

describe("PullRequestsWorkspace", () => {
  beforeEach(() => {
    cachedRecord = null;
    savedPages.length = 0;
    listImpl = async () => ({ items: [], nextCursor: null, partial: false, fetchedAt: 1 });
    detailImpl = async () => ({ item: null, error: "missing", fetchedAt: 1 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the cached first page before the live refresh completes", async () => {
    cachedRecord = { items: [summary(41, { title: "Cached row" })], fetchedAt: 1 };
    let resolveList!: (value: unknown) => void;
    listImpl = () => new Promise((resolve) => { resolveList = resolve; });
    const wrapper = await mountWorkspace();

    expect(wrapper.get('[data-testid="pull-request-row-41"]').text()).toContain("Cached row");
    expect(wrapper.get('[data-testid="pr-cache-status"]').exists()).toBe(true);

    resolveList({ items: [summary(42, { title: "Fresh row" })], nextCursor: null, partial: false, fetchedAt: 2 });
    await flushPromises();
    expect(wrapper.find('[data-testid="pull-request-row-41"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="pull-request-row-42"]').text()).toContain("Fresh row");
    expect(savedPages).toHaveLength(1);
  });

  it("refreshes scoped filters and appends cursor pages without duplicates", async () => {
    const queries: Record<string, unknown>[] = [];
    listImpl = async (encoded) => {
      const query = JSON.parse(encoded) as Record<string, unknown>;
      queries.push(query);
      if (query.state === "closed") return { items: [summary(50, { state: "closed" })], nextCursor: null, partial: false, fetchedAt: 3 };
      if (query.cursor) return { items: [summary(42), summary(43)], nextCursor: null, partial: false, fetchedAt: 3 };
      return { items: [summary(42)], nextCursor: "cursor-2", partial: false, fetchedAt: 2 };
    };
    const wrapper = await mountWorkspace();
    expect(wrapper.find('[data-testid="pull-request-row-42"]').exists()).toBe(true);

    await wrapper.get(".prLoadMore").trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-testid^="pull-request-row-"]')).toHaveLength(2);
    expect(wrapper.find('[data-testid="pull-request-row-43"]').exists()).toBe(true);
    expect(queries.some((query) => query.cursor === "cursor-2")).toBe(true);

    await wrapper.get('[data-testid="pr-filter-state-closed"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="pull-request-row-42"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="pull-request-row-50"]').exists()).toBe(true);
    expect(queries.at(-1)?.state).toBe("closed");

    await wrapper.get('[data-testid="pr-refresh"]').trigger("click");
    await flushPromises();
    expect(queries.at(-1)?.refresh).toBe(true);
  });

  it("keeps cached rows visible when the server returns an explicit offline error", async () => {
    cachedRecord = { items: [summary(42)], fetchedAt: 1 };
    listImpl = async () => ({ items: [], nextCursor: null, partial: false, error: "offline", fetchedAt: 2 });
    const wrapper = await mountWorkspace();
    expect(wrapper.find('[data-testid="pull-request-row-42"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="pr-list-error"]').text()).toContain("offline");
    expect(wrapper.get('[data-testid="pr-list-error"]').text()).toContain("cached or partial rows");
  });

  it("ignores a stale pagination failure after the filter scope changes", async () => {
    let rejectOldPage!: (reason: unknown) => void;
    listImpl = async (encoded) => {
      const query = JSON.parse(encoded) as Record<string, unknown>;
      if (query.state === "closed" && query.cursor === "closed-next") {
        return { items: [summary(61)], nextCursor: null, partial: false, fetchedAt: 4 };
      }
      if (query.state === "closed") {
        return { items: [summary(60, { state: "closed" })], nextCursor: "closed-next", partial: false, fetchedAt: 3 };
      }
      if (query.cursor === "old-next") {
        return new Promise((_, reject) => { rejectOldPage = reject; });
      }
      return { items: [summary(42)], nextCursor: "old-next", partial: false, fetchedAt: 1 };
    };
    const wrapper = await mountWorkspace();
    await wrapper.get(".prLoadMore").trigger("click");
    await Promise.resolve();
    await wrapper.get('[data-testid="pr-filter-state-closed"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="pull-request-row-60"]').exists()).toBe(true);

    rejectOldPage(new Error("stale page failure"));
    await flushPromises();
    expect(wrapper.find('[data-testid="pr-list-error"]').exists()).toBe(false);

    await wrapper.get(".prLoadMore").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="pull-request-row-61"]').exists()).toBe(true);
  });

  it("loads detail and checks only after a row is selected", async () => {
    listImpl = async () => ({ items: [summary(42)], nextCursor: null, partial: false, fetchedAt: 1 });
    const detail: PullRequestDetail = {
      ...summary(42),
      body: "## Summary\nLazy detail",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      checksDetail: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci" }],
      reviews: [{ author: "reviewer", state: "APPROVED", submittedAt: "2026-11-20T11:00:00Z" }],
      files: [{ path: "client/src/App.vue", additions: 2, deletions: 1 }],
    };
    let detailCalls = 0;
    detailImpl = async () => {
      detailCalls += 1;
      return { item: detail, fetchedAt: 2 };
    };
    const wrapper = await mountWorkspace();
    expect(detailCalls).toBe(0);

    await wrapper.get('[data-testid="pull-request-row-42"]').trigger("click");
    await flushPromises();
    expect(detailCalls).toBe(1);
    expect(wrapper.get('[data-testid="pull-request-detail"]').text()).toContain("Lazy detail");
    expect(wrapper.get('[data-testid="pull-request-detail"]').text()).toContain("client/src/App.vue");
    expect(wrapper.get('[data-testid="pull-request-detail"]').text()).toContain("reviewer");
    expect(wrapper.get('[data-testid="pull-request-detail"]').get("a").attributes("href")).toBe("https://github.com/Andy963/ads/pull/42");
  });
});
