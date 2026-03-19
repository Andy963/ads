import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runAdsCommandLine } from "../../server/web/commandRouter.js";

describe("web command router", () => {
  it("keeps ads.help available with the updated guidance", async () => {
    const result = await runAdsCommandLine("/ads.help");

    assert.equal(result.ok, true);
    assert.match(result.output, /Use the Web UI and skills to drive specs, drafts, and tasks/);
  });

  it("rejects removed workflow lifecycle commands", async () => {
    const result = await runAdsCommandLine("/ads.status");

    assert.equal(result.ok, false);
    assert.match(result.output, /Unknown command: ads\.status/);
  });
});
