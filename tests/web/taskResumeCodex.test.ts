import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCodexResumeProbeArgs } from "../../server/web/server/ws/taskResumeCodex.js";

describe("web/ws/taskResumeCodex", () => {
  it("builds read-only resume probe args", () => {
    assert.deepEqual(
      buildCodexResumeProbeArgs({ threadId: "thread-1", sandboxMode: "read-only" as any }),
      ["exec", "--sandbox", "read-only", "--json", "--skip-git-repo-check", "resume", "thread-1", "-"],
    );
  });

  it("builds danger-full-access resume probe args", () => {
    assert.deepEqual(
      buildCodexResumeProbeArgs({ threadId: "thread-1", sandboxMode: "danger-full-access" as any }),
      ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json", "--skip-git-repo-check", "resume", "thread-1", "-"],
    );
  });

  it("defaults other sandbox modes to full-auto", () => {
    assert.deepEqual(
      buildCodexResumeProbeArgs({ threadId: "thread-1", sandboxMode: "workspace-write" as any }),
      ["exec", "--full-auto", "--json", "--skip-git-repo-check", "resume", "thread-1", "-"],
    );
  });
});
