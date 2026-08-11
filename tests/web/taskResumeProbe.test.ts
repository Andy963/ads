import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { probeSessionOnDisk } from "../../server/agents/sessions/sessionPaths.js";
import { assertSessionResumable } from "../../server/web/server/ws/taskResumeProbe.js";
import { isPermanentTaskResumeFailure } from "../../server/web/server/ws/taskResume.js";

async function withCodexHome<T>(setup: (home: string) => Promise<void>, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CODEX_HOME;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ads-codex-home-"));
  try {
    await setup(home);
    process.env.CODEX_HOME = home;
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fsp.rm(home, { recursive: true, force: true });
  }
}

describe("web/ws/taskResumeProbe", () => {
  it("finds a codex thread by its rollout filename", async () => {
    const found = await withCodexHome(
      async (home) => {
        const dir = path.join(home, "sessions", "2026", "08", "09");
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, "rollout-2026-08-09T18-12-51-thread-xyz.jsonl"), "{}\n");
      },
      () => probeSessionOnDisk({ agentId: "codex", sessionId: "thread-xyz" }),
    );
    assert.equal(found, "present");
  });

  it("reports a missing thread as absent when the sessions root is readable", async () => {
    const probe = await withCodexHome(
      async (home) => {
        await fsp.mkdir(path.join(home, "sessions"), { recursive: true });
      },
      () => probeSessionOnDisk({ agentId: "codex", sessionId: "thread-missing" }),
    );
    assert.equal(probe, "absent");
  });

  it("reports unknown when the provider root does not exist", async () => {
    const probe = await withCodexHome(
      async () => {},
      () => probeSessionOnDisk({ agentId: "codex", sessionId: "thread-xyz" }),
    );
    assert.equal(probe, "unknown");
  });

  it("treats agents without a known layout as unknown", async () => {
    assert.equal(await probeSessionOnDisk({ agentId: "gemini", sessionId: "x" }), "unknown");
  });

  it("does not reject a session when the root is unreadable", async () => {
    await withCodexHome(
      async () => {},
      () => assertSessionResumable({ agentId: "codex", sessionId: "thread-xyz" }),
    );
  });

  it("rejects an absent session with a permanently-classified message", async () => {
    const error = await withCodexHome(
      async (home) => {
        await fsp.mkdir(path.join(home, "sessions"), { recursive: true });
      },
      async () => {
        try {
          await assertSessionResumable({ agentId: "codex", sessionId: "thread-missing" });
          return null;
        } catch (err) {
          return err as Error;
        }
      },
    );

    assert.ok(error, "expected the probe to reject an absent session");
    // The saved-id cleanup path keys off this classification.
    assert.equal(isPermanentTaskResumeFailure(error.message), true);
  });

  it("rejects an empty session id", async () => {
    await assert.rejects(() => assertSessionResumable({ agentId: "codex", sessionId: "  " }), /empty session id/);
  });
});
