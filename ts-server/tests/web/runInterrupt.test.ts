import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deriveProjectSessionId } from "../../server/web/server/projectSessionId.js";
import { handleRunRoutes } from "../../server/web/server/api/routes/runs.js";
import { resolveSyncLaneKey } from "../../server/web/server/sync/lane.js";

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

function createRes(): FakeRes {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

describe("run interrupt HTTP fallback", () => {
  let tmpDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-run-interrupt-"));
    workspaceRoot = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function callInterrupt(args: {
    interruptControllers: Map<string, AbortController>;
    promptRunEpochs?: Map<string, number>;
    method?: string;
    query?: string;
  }): Promise<{ handled: boolean; res: FakeRes }> {
    const res = createRes();
    const query = args.query ?? `sessionId=default&chatSessionId=main&workspace=${encodeURIComponent(workspaceRoot)}`;
    return handleRunRoutes(
      {
        req: { method: args.method ?? "POST" } as any,
        res: res as any,
        url: new URL(`http://localhost/api/runs/interrupt?${query}`),
        pathname: "/api/runs/interrupt",
        auth: { userId: "u-1", username: "admin" },
      },
      {
        defaultWorkspaceRoot: workspaceRoot,
        resolveWorkspaceRoot: () => workspaceRoot,
        interruptControllers: args.interruptControllers,
        promptRunEpochs: args.promptRunEpochs,
      },
    ).then((handled) => ({ handled, res }));
  }

  it("aborts the caller's in-flight run without a WebSocket connection", async () => {
    const sessionId = deriveProjectSessionId(workspaceRoot);
    const laneKey = resolveSyncLaneKey({ authUserId: "u-1", sessionId, chatSessionId: "main" });
    const controller = new AbortController();
    const interruptControllers = new Map([[laneKey, controller]]);
    const promptRunEpochs = new Map([[laneKey, 3]]);

    const { handled, res } = await callInterrupt({ interruptControllers, promptRunEpochs });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, interrupted: true });
    assert.equal(controller.signal.aborted, true);
    assert.equal(interruptControllers.has(laneKey), false);
    // The epoch bump is what stops a late-completing run from writing its result.
    assert.equal(promptRunEpochs.get(laneKey), 4);
  });

  it("reports interrupted=false when nothing is running", async () => {
    const { res } = await callInterrupt({ interruptControllers: new Map() });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, interrupted: false });
  });

  it("cannot interrupt another user's run", async () => {
    const sessionId = deriveProjectSessionId(workspaceRoot);
    const victimLane = resolveSyncLaneKey({ authUserId: "u-2", sessionId, chatSessionId: "main" });
    const controller = new AbortController();
    const interruptControllers = new Map([[victimLane, controller]]);

    const { res } = await callInterrupt({ interruptControllers });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, interrupted: false });
    assert.equal(controller.signal.aborted, false);
    assert.equal(interruptControllers.has(victimLane), true);
  });

  it("rejects a sessionId that does not match the workspace", async () => {
    const { res } = await callInterrupt({
      interruptControllers: new Map(),
      query: `sessionId=someone-elses-session&workspace=${encodeURIComponent(workspaceRoot)}`,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /does not match workspace/);
  });

  it("rejects non-POST methods", async () => {
    const { handled, res } = await callInterrupt({ interruptControllers: new Map(), method: "GET" });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
  });
});
