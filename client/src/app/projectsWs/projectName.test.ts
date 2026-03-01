import { describe, expect, it } from "vitest";

import { deriveProjectNameFromPath, resolveDefaultProjectName } from "./projectName";

describe("projectName helpers", () => {
  it("derives fallback name for empty path", () => {
    expect(deriveProjectNameFromPath("")).toBe("Workspace");
  });

  it("derives basename from unix and windows paths", () => {
    expect(deriveProjectNameFromPath("/tmp/repo/ads/")).toBe("ads");
    expect(deriveProjectNameFromPath("C:\\Users\\andy\\ads\\")).toBe("ads");
  });

  it("uses derived name when input name is a placeholder alias", () => {
    expect(resolveDefaultProjectName({ name: "", path: "/tmp/repo/ads" })).toBe("ads");
    expect(resolveDefaultProjectName({ name: "default", path: "/tmp/repo/ads" })).toBe("ads");
    expect(resolveDefaultProjectName({ name: "Workspace", path: "/tmp/repo/ads" })).toBe("ads");
    expect(resolveDefaultProjectName({ name: "默认", path: "/tmp/repo/ads" })).toBe("ads");
  });

  it("preserves explicit non-placeholder names", () => {
    expect(resolveDefaultProjectName({ name: "Infra", path: "/tmp/repo/ads" })).toBe("Infra");
  });
});
