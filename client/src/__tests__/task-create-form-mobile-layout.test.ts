import { describe, expect, it } from "vitest";

import { readSfc } from "./readSfc";

describe("TaskCreateForm mobile actions", () => {
  it("keeps the three bottom actions compact and horizontal", async () => {
    const sfc = await readSfc("../components/TaskCreateForm.vue", import.meta.url);

    expect(sfc).toMatch(
      /\.actionsRight\s*\{\s*flex-direction:\s*row;\s*justify-content:\s*flex-end;\s*gap:\s*8px;\s*\}/,
    );
    expect(sfc).toMatch(
      /\.actionsRight button\s*\{\s*width:\s*auto;\s*min-height:\s*30px;\s*padding:\s*6px 10px;\s*border-radius:\s*10px;\s*font-size:\s*12px;/,
    );
  });
});
