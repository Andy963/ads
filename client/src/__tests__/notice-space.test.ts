import { describe, expect, it } from "vitest";
import { noticeSpace } from "../composables/app/useNoticeSpace";

describe("notice space reservation", () => {
  it("caps long notices without using the controls' reserved space", () => {
    expect(noticeSpace(500, 844, 19.5, 2)).toEqual({ height: 211, margin: 6, padding: 8 });
  });
  it("compacts spacing before clipping a text line on a short viewport", () => {
    const result = noticeSpace(30, 320, 19.5, 2);
    expect(result).toEqual({ height: 21.5, margin: 4.25, padding: 0 });
    expect(result.height + result.margin * 2).toBe(30);
  });
  it("shrinks when a connection status or multiline composer grows", () => {
    for (const available of [160, 70, 45, 25]) {
      const result = noticeSpace(available, 360, 19.5, 2);
      expect(result.height + result.margin * 2).toBeLessThanOrEqual(available);
      expect(result.height - result.padding * 2 - 2).toBeGreaterThanOrEqual(19.5);
    }
    expect(noticeSpace(-20, 320, 19.5, 2).height).toBe(0);
  });
});
