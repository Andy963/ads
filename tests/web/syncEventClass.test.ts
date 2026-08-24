import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifySyncEvent, isTransientSyncEvent } from "../../server/web/server/sync/eventClass.js";

describe("web/sync event classification", () => {
  it("keeps agent snapshots out of the replay log", () => {
    assert.equal(classifySyncEvent("agents"), "transient");
    assert.equal(isTransientSyncEvent("agents"), true);
  });
});
