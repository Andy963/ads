import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS_LANE_ID,
  ACTIONS_ROLE_IDS,
  ACOPILOT_LANE_ID,
  CANONICAL_LANE_IDS,
  LEGACY_LANE_ALIASES,
  LEGACY_ROLE_PROFILE_ALIASES,
  STORED_ROLE_PROFILE_VALUES,
  isActionsRole,
  isCanonicalLaneId,
  isStoredRoleProfileValue,
  laneIdVariants,
  normalizeActionsRole,
  normalizeLaneId,
  normalizeStoredRoleProfileValue,
} from "../../shared/terminology.js";

describe("shared/terminology compatibility matrix", () => {
  it("exposes exactly the two canonical top-level lanes", () => {
    assert.deepEqual([...CANONICAL_LANE_IDS], ["acopilot", "actions"]);
  });

  it("names each canonical lane and keeps the array derived from those names", () => {
    // The client imports the individual constants; deriving the array from them
    // is what stops the two spellings from drifting apart.
    assert.equal(ACOPILOT_LANE_ID, "acopilot");
    assert.equal(ACTIONS_LANE_ID, "actions");
    assert.deepEqual([...CANONICAL_LANE_IDS], [ACOPILOT_LANE_ID, ACTIONS_LANE_ID]);
  });

  it("exposes Reviewer as the only Actions role", () => {
    assert.deepEqual([...ACTIONS_ROLE_IDS], ["reviewer"]);
  });

  it("keeps top-level lanes and Actions roles disjoint", () => {
    for (const lane of CANONICAL_LANE_IDS) {
      assert.equal(isActionsRole(lane), false, `${lane} must not be an Actions role`);
    }
    for (const role of ACTIONS_ROLE_IDS) {
      assert.equal(isCanonicalLaneId(role), false, `${role} must not be a top-level lane`);
    }
  });

  it("never treats Reviewer as a top-level lane", () => {
    // Enforced at runtime here, and at compile time everywhere else: the two
    // vocabularies are disjoint union types, so any slot typed CanonicalLaneId
    // rejects "reviewer" without a cast. The repository typecheck excludes
    // tests/, so this assertion is the one the gate actually runs.
    assert.equal(isCanonicalLaneId("reviewer"), false);
    assert.equal(normalizeLaneId("reviewer"), null);

    assert.equal(isActionsRole("reviewer"), true);
    assert.equal(normalizeActionsRole("reviewer"), "reviewer");
  });

  it("maps every legacy lane alias to its canonical lane", () => {
    assert.equal(normalizeLaneId("advisor"), "acopilot");
    assert.equal(normalizeLaneId("planner"), "acopilot");
    assert.equal(normalizeLaneId("worker"), "actions");
  });

  it("accepts canonical lane values unchanged", () => {
    for (const lane of CANONICAL_LANE_IDS) {
      assert.equal(normalizeLaneId(lane), lane);
    }
  });

  it("tolerates surrounding whitespace and non-string input", () => {
    assert.equal(normalizeLaneId("  advisor  "), "acopilot");
    assert.equal(normalizeLaneId(null), null);
    assert.equal(normalizeLaneId(undefined), null);
    assert.equal(normalizeLaneId(42), null);
  });

  it("fails closed on unknown lane input instead of routing it anywhere", () => {
    for (const unknown of ["", "   ", "planners", "actions2", "Developer", "REVIEWER"]) {
      assert.equal(normalizeLaneId(unknown), null, `${unknown} must not resolve to a lane`);
    }
  });

  it("fails closed on inherited Object.prototype keys, not just odd strings", () => {
    // A bare index into the alias tables would resolve these to inherited
    // functions and objects, letting a non-lane value pass as a lane id.
    const inherited = [
      "toString",
      "constructor",
      "__proto__",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ];
    for (const key of inherited) {
      assert.equal(normalizeLaneId(key), null, `${key} must not resolve to a lane`);
      assert.equal(normalizeStoredRoleProfileValue(key), null, `${key} must not resolve to a role`);
      assert.equal(isCanonicalLaneId(key), false);
      assert.equal(isStoredRoleProfileValue(key), false);
    }
  });

  it("resolves stored role profiles through their own alias table", () => {
    assert.equal(normalizeStoredRoleProfileValue("developer"), "acopilot");
    assert.equal(normalizeStoredRoleProfileValue("worker"), "acopilot");
    assert.equal(normalizeStoredRoleProfileValue("advisor"), "acopilot");
    assert.equal(normalizeLaneId("worker"), "actions");
  });

  it("keeps stored role profiles limited to Acopilot and Reviewer", () => {
    assert.deepEqual([...STORED_ROLE_PROFILE_VALUES], ["acopilot", "reviewer"]);
    for (const value of STORED_ROLE_PROFILE_VALUES) {
      assert.equal(isStoredRoleProfileValue(value), true);
    }
    assert.equal(isStoredRoleProfileValue("actions"), false);
    assert.equal(normalizeStoredRoleProfileValue("actions"), null);
  });

  it("rejects a retired implementation role from the Actions role vocabulary", () => {
    assert.equal(normalizeActionsRole("worker"), null);
    assert.equal(normalizeActionsRole("advisor"), null);
    assert.equal(normalizeActionsRole(""), null);
    assert.equal(normalizeActionsRole("developer"), null);
  });

  it("orders lane variants canonical-first and deterministically", () => {
    assert.deepEqual(laneIdVariants("acopilot"), ["acopilot", "advisor", "planner"]);
    assert.deepEqual(laneIdVariants("actions"), ["actions", "worker"]);
    assert.deepEqual(laneIdVariants("advisor"), ["advisor"]);
    assert.deepEqual(laneIdVariants(""), []);
    assert.deepEqual(laneIdVariants(null), []);
  });

  it("keeps the alias tables and the normalizers in agreement", () => {
    for (const [alias, canonical] of Object.entries(LEGACY_LANE_ALIASES)) {
      assert.equal(normalizeLaneId(alias), canonical);
      assert.equal(isCanonicalLaneId(alias), false, `${alias} is legacy, not canonical`);
    }
    for (const [alias, canonical] of Object.entries(LEGACY_ROLE_PROFILE_ALIASES)) {
      assert.equal(normalizeStoredRoleProfileValue(alias), canonical);
    }
  });

  it("does not treat a legacy alias as a role unless the role table says so", () => {
    // planner is a lane alias only; it was never a stored role profile.
    assert.equal(normalizeLaneId("planner"), "acopilot");
    assert.equal(normalizeStoredRoleProfileValue("planner"), null);
  });
});
