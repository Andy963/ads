import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldExposeInteractiveActionTools } from "../../server/web/server/ws/actionToolExposure.js";
import { WEB_ACOPILOT_NAMESPACE, WEB_ACTIONS_NAMESPACE } from "../../server/web/server/start/webLaneResources.js";

describe("interactive review tool exposure", () => {
  it("exposes tools only to authenticated Acopilot lanes with a factory", () => {
    assert.equal(shouldExposeInteractiveActionTools({
      isConnector: false,
      laneNamespace: WEB_ACOPILOT_NAMESPACE,
      factoryAvailable: true,
    }), true);
  });

  it("does not expose tools to Actions, connector, or unavailable-factory lanes", () => {
    for (const input of [
      { isConnector: false, laneNamespace: WEB_ACTIONS_NAMESPACE, factoryAvailable: true },
      { isConnector: true, laneNamespace: WEB_ACTIONS_NAMESPACE, factoryAvailable: true },
      { isConnector: false, laneNamespace: WEB_ACOPILOT_NAMESPACE, factoryAvailable: false },
    ]) {
      assert.equal(shouldExposeInteractiveActionTools(input), false);
    }
  });
});
