import { describe, expect, it } from "vitest";

import {
  errorRecoveryGeneration,
  notifyRuntimeRenderError,
  resetRuntimeRecoveryForTests,
} from "./errorRecovery";

describe("runtime render error handling", () => {
  it("does not re-key the component tree from the Vue error handler", () => {
    resetRuntimeRecoveryForTests();

    expect(notifyRuntimeRenderError(new RangeError("Maximum call stack size exceeded"), "component update")).toBe(true);
    expect(errorRecoveryGeneration.value).toBe(0);
  });
});
