import { clearLiveActivityWindow, createLiveActivityWindow, ingestCommandActivity, ingestExploredActivity, renderLiveActivityMarkdown } from "./live_activity";

describe("live_activity", () => {
  test("keeps only the last N explored steps", () => {
    const window = createLiveActivityWindow(3);
    ingestExploredActivity(window, "List", "a");
    ingestExploredActivity(window, "List", "b");
    ingestExploredActivity(window, "List", "c");
    ingestExploredActivity(window, "List", "d");
    expect(window.steps.map((s) => s.summary)).toEqual(["b", "c", "d"]);
  });

  test("pairs command after explored step", () => {
    const window = createLiveActivityWindow(5);
    ingestExploredActivity(window, "List", "files");
    ingestCommandActivity(window, "ls -a");
    expect(window.steps).toHaveLength(1);
    expect(window.steps[0]!.command).toBe("ls -a");
  });

  test("pairs command that arrives before explored step", () => {
    const window = createLiveActivityWindow(5);
    ingestCommandActivity(window, "rg foo src");
    ingestExploredActivity(window, "Search", "foo in src");
    expect(window.steps).toHaveLength(1);
    expect(window.steps[0]!.command).toBe("rg foo src");
  });

  test("clears window", () => {
    const window = createLiveActivityWindow(5);
    ingestExploredActivity(window, "Tool", "shell");
    ingestCommandActivity(window, "echo ok");
    clearLiveActivityWindow(window);
    expect(window.steps).toHaveLength(0);
    expect(window.pendingCommand).toBeNull();
  });

  test("renders markdown", () => {
    const window = createLiveActivityWindow(5);
    ingestExploredActivity(window, "List", "ls -a");
    ingestCommandActivity(window, "ls -a");
    const md = renderLiveActivityMarkdown(window);
    expect(md).toContain("- **List: ls -a**");
    expect(md).not.toContain("Execute: `ls -a`");
  });
});
