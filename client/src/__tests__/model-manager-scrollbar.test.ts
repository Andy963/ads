import { describe, it, expect } from "vitest";
import { readSfc } from "./readSfc";

describe("model manager scrollbar styling", () => {
  it("keeps all model-related scroll containers visible across browsers", async () => {
    const css = await readSfc("../components/ModelManager.vue", import.meta.url);
    const selectors = [".cliList", ".syncModelList", ".dialogBody", ".lanePromptPanel"];

    for (const selector of selectors) {
      expect(css).toContain(selector);
      expect(css).toContain(`${selector}::-webkit-scrollbar`);
      expect(css).toContain(`${selector}::-webkit-scrollbar-thumb`);
      expect(css).toContain(`${selector}::-webkit-scrollbar-track`);
    }

    expect(css).toContain("scrollbar-width: thin;");
    expect(css).toContain("scrollbar-gutter: stable;");
    expect(css).toContain("scrollbar-color: rgba(148, 163, 184, 0.55) transparent;");
    expect(css).toContain("width: 8px;");
  });
});
