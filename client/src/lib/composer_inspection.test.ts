import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSfc } from "../__tests__/readSfc";

type InspectionReport = {
  initial: { environment: { serviceWorker: string | null; scripts: string[] }; input: { length: number; lines: number } };
  records: Array<{ type: string; defaultPrevented?: boolean }>;
};

type Inspection = { report: () => InspectionReport; stop: () => InspectionReport };
const inspectionWindow = window as unknown as { ADSComposerInspection?: Inspection };
const originalHitTest = document.elementFromPoint;

describe("temporary composer inspection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("fetch", vi.fn());
    document.body.innerHTML = '<div class="app"><span class="drawerBrandVersion">v0.2.5</span><div class="detail"><div class="composer"><div class="inputWrap"><div class="composerMainRow"><textarea class="composer-input"></textarea><button data-testid="composer-actions-toggle" aria-expanded="false">+</button></div></div></div></div></div>';
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 200, 260, 34));
    document.elementFromPoint = vi.fn(() => document.querySelector("button"));
  });

  afterEach(() => {
    inspectionWindow.ADSComposerInspection?.stop();
    document.body.innerHTML = "";
    document.querySelector('[data-inspection-fixture="true"]')?.remove();
    document.elementFromPoint = originalHitTest;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function install(): Promise<Inspection> {
    const source = await readSfc("../../../scripts/inspect-composer.js", import.meta.url);
    new Function(source)();
    const inspection = inspectionWindow.ADSComposerInspection;
    if (!inspection) throw new Error("Inspection was not installed");
    return inspection;
  }

  it("exports only draft metrics and sanitized asset paths without reading credentials or using the network", async () => {
    const input = document.querySelector("textarea")!;
    input.value = "PRIVATE_DRAFT\nPRIVATE_SECOND_LINE";
    const script = document.createElement("script");
    script.src = "/assets/app.js?token=PRIVATE_CREDENTIAL";
    script.dataset.inspectionFixture = "true";
    document.head.appendChild(script);
    vi.spyOn(document, "cookie", "get").mockImplementation(() => { throw new Error("Credential access is forbidden"); });
    const inspection = await install();
    const report = inspection.report();

    expect(report.initial.input).toMatchObject({ length: input.value.length, lines: 2 });
    expect(report.initial.environment.serviceWorker).toBeNull();
    expect(report.initial.environment.scripts).toContain("/assets/app.js");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
    expect(fetch).not.toHaveBeenCalled();
    inspection.stop();
    expect(input.value).toBe("PRIVATE_DRAFT\nPRIVATE_SECOND_LINE");
    expect(inspectionWindow.ADSComposerInspection).toBeUndefined();
  });

  it("captures post-handler cancellation and removes event listeners and pending frames on stop", async () => {
    const inspection = await install();
    const toggle = document.querySelector("button")!;
    toggle.addEventListener("mousedown", event => event.preventDefault());
    toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(32);
    expect(inspection.report().records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mousedown", defaultPrevented: false }),
      expect.objectContaining({ type: "mousedown:rendered", defaultPrevented: true }),
    ]));

    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const count = inspection.stop().records.length;
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    vi.advanceTimersByTime(32);
    expect(inspection.report().records).toHaveLength(count);
  });
});
