import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  handlePullRequestRoutes,
  listPullRequestsForProject,
  readPullRequestDetailForProject,
  resetPullRequestRouteCachesForTests,
  type GhRunner,
} from "../../server/web/server/api/routes/pullRequests.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";
import { upsertWebProject } from "../../server/web/projects/store.js";

const baseRows = [
  {
    number: 42,
    title: "Fix project navigation",
    url: "https://github.com/Andy963/ads/pull/42",
    state: "OPEN",
    isDraft: false,
    author: { login: "andy" },
    updatedAt: "2026-11-20T10:00:00Z",
    createdAt: "2026-11-19T10:00:00Z",
    labels: [{ name: "bug", color: "d73a4a" }],
    statusCheckRollup: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/42" },
    ],
    additions: 12,
    deletions: 3,
    headRefName: "fix/navigation",
    baseRefName: "dev",
  },
  {
    number: 43,
    title: "Add PR workspace",
    url: "https://github.com/Andy963/ads/pull/43",
    state: "OPEN",
    isDraft: true,
    author: { login: "andy" },
    updatedAt: "2026-11-20T11:00:00Z",
    createdAt: "2026-11-19T11:00:00Z",
    labels: [],
    statusCheckRollup: [{ name: "test", status: "IN_PROGRESS", conclusion: "" }],
    additions: 20,
    deletions: 1,
    headRefName: "feat/pr-workspace",
    baseRefName: "dev",
  },
  {
    number: 44,
    title: "Retire stale path",
    url: "https://github.com/Andy963/ads/pull/44",
    state: "CLOSED",
    isDraft: false,
    author: { login: "other" },
    updatedAt: "2026-11-20T12:00:00Z",
    createdAt: "2026-11-19T12:00:00Z",
    labels: [{ name: "chore", color: "ffffff" }],
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
    additions: 4,
    deletions: 8,
    headRefName: "chore/path",
    baseRefName: "dev",
  },
];

function query(overrides: Partial<Parameters<typeof listPullRequestsForProject>[0]["query"]> = {}) {
  return {
    projectId: "project-1",
    state: "open" as const,
    involvement: "all" as const,
    labels: [] as string[],
    author: "",
    checks: "all" as const,
    limit: 2,
    ...overrides,
  };
}

describe("pull request routes", () => {
  beforeEach(() => {
    resetPullRequestRouteCachesForTests();
  });

  it("returns bounded summary pages with a cursor and normalized fields", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const runner: GhRunner = async (args, options) => {
      calls.push({ args, cwd: options.cwd });
      return { stdout: JSON.stringify(baseRows) };
    };
    const first = await listPullRequestsForProject({ projectKey: "u:p", cwd: "/repo", query: query(), runner, now: 1_000 });

    assert.deepEqual(first.items.map((item) => item.number), [42, 43]);
    assert.ok(first.nextCursor);
    assert.deepEqual(
      {
        repository: first.items[0]?.repository,
        author: first.items[0]?.author,
        checks: first.items[0]?.checks,
        additions: first.items[0]?.additions,
        deletions: first.items[0]?.deletions,
      },
      { repository: "Andy963/ads", author: "andy", checks: "passing", additions: 12, deletions: 3 },
    );
    assert.equal(first.items[1]?.checks, "pending");

    const second = await listPullRequestsForProject({
      projectKey: "u:p",
      cwd: "/repo",
      query: query({ cursor: first.nextCursor ?? undefined }),
      runner,
      now: 2_000,
    });
    assert.deepEqual(second.items.map((item) => item.number), [44]);
    assert.equal(second.items[0]?.checks, "failing");
    assert.equal(second.nextCursor, null);
    assert.equal(calls.length, 2);
  });

  it("maps filters to server-side gh search arguments", async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async (args) => {
      calls.push(args);
      return { stdout: "[]" };
    };
    await listPullRequestsForProject({
      projectKey: "u:p",
      cwd: "/repo",
      query: query({
        state: "merged",
        involvement: "review-requested",
        labels: ["ready for review"],
        author: "andy",
        checks: "failing",
      }),
      runner,
      now: 1_000,
    });

    const args = calls[0] ?? [];
    assert.ok(args.includes("--state"));
    assert.ok(args.includes("merged"));
    assert.ok(args.includes("--search"));
    const search = args.join(" ");
    assert.match(search, /review-requested:@me/);
    assert.match(search, /label:"ready for review"/);
    assert.match(search, /author:"andy"/);
    assert.match(search, /status:failure/);
  });

  it("deduplicates concurrent reads and serves a short-lived cache", async () => {
    let resolve!: (value: { stdout: string; stderr?: string }) => void;
    let calls = 0;
    const runner: GhRunner = () => {
      calls += 1;
      if (calls > 1) return Promise.resolve({ stdout: JSON.stringify(baseRows) });
      return new Promise((done) => { resolve = done; });
    };
    const first = listPullRequestsForProject({ projectKey: "u:p", cwd: "/repo", query: query(), runner, now: 1_000 });
    const second = listPullRequestsForProject({ projectKey: "u:p", cwd: "/repo", query: query(), runner, now: 1_001 });
    await Promise.resolve();
    assert.equal(calls, 1);
    resolve({ stdout: JSON.stringify(baseRows) });
    await Promise.all([first, second]);

    await listPullRequestsForProject({ projectKey: "u:p", cwd: "/repo", query: query(), runner, now: 2_000 });
    assert.equal(calls, 1);
    await listPullRequestsForProject({ projectKey: "u:p", cwd: "/repo", query: query({ refresh: true }), runner, now: 2_001 });
    assert.equal(calls, 2);
  });

  it("returns explicit failure metadata instead of throwing", async () => {
    const runner: GhRunner = async () => { throw new Error("gh unavailable"); };
    const response = await listPullRequestsForProject({ projectKey: "u:p", cwd: "/repo", query: query(), runner, now: 1_000 });
    assert.deepEqual(
      { items: response.items, nextCursor: response.nextCursor, partial: response.partial, error: response.error },
      { items: [], nextCursor: null, partial: false, error: "gh unavailable" },
    );
  });

  it("loads detail fields only on demand", async () => {
    const detailRow = {
      ...baseRows[0],
      body: "## Summary\nDetails",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      reviews: [{ author: { login: "reviewer" }, state: "APPROVED", submittedAt: "2026-11-20T12:00:00Z" }],
      files: [{ path: "client/src/App.vue", additions: 2, deletions: 1 }],
    };
    const runner: GhRunner = async () => ({ stdout: JSON.stringify(detailRow) });
    const response = await readPullRequestDetailForProject({ projectKey: "u:p", cwd: "/repo", number: 42, runner, now: 1_000 });
    assert.match(response.item.body, /Details/);
    assert.deepEqual(response.item.checksDetail[0], {
      name: "test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://ci/42",
    });
    assert.deepEqual(response.item.reviews[0], {
      author: "reviewer",
      state: "APPROVED",
      submittedAt: "2026-11-20T12:00:00Z",
    });
    assert.deepEqual(response.item.files[0], { path: "client/src/App.vue", additions: 2, deletions: 1 });
  });

  it("serves a project-scoped typed API response and rejects an unknown project", async () => {
    const previousState = process.env.ADS_STATE_DB_PATH;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pr-route-"));
    process.env.ADS_STATE_DB_PATH = path.join(directory, "state.db");
    resetStateDatabaseForTests();
    try {
      const db = getStateDatabase();
      ensureWebAuthTables(db);
      ensureWebProjectTables(db);
      db.prepare(
        `INSERT INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run("user-1", "andy", "hash", 1, 1);
      upsertWebProject(db, { userId: "user-1", projectId: "p1", workspaceRoot: "/repo", name: "ads" });
      const runner: GhRunner = async () => ({ stdout: JSON.stringify(baseRows) });
      const makeResponse = () => {
        const response = {
          statusCode: 0,
          body: "",
          headers: {} as Record<string, string>,
          setHeader(name: string, value: string) { this.headers[name] = value; },
          writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; },
          end(body: string) { this.body = body; },
        };
        return response;
      };
      const invoke = async (urlText: string) => {
        const response = makeResponse();
        const url = new URL(urlText, "http://localhost");
        await handlePullRequestRoutes({
          req: { method: "GET" } as never,
          res: response as never,
          url,
          pathname: url.pathname,
          auth: { userId: "user-1", username: "Andy" },
        }, { defaultWorkspaceRoot: "/repo", runner });
        return response;
      };

      const ok = await invoke("/api/pull-requests?projectId=p1&state=open&limit=2");
      assert.equal(ok.statusCode, 200);
      const body = JSON.parse(ok.body) as { items: Array<{ number: number }> };
      assert.deepEqual(body.items.map((item) => item.number), [42, 43]);

      const missing = await invoke("/api/pull-requests?projectId=missing");
      assert.equal(missing.statusCode, 404);
    } finally {
      resetStateDatabaseForTests();
      if (previousState === undefined) delete process.env.ADS_STATE_DB_PATH;
      else process.env.ADS_STATE_DB_PATH = previousState;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
