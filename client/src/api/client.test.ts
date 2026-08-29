import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "./client";

describe("ApiClient error responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose an intermediary HTML error page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<!DOCTYPE html><html><body>Not Found</body></html>", {
            status: 404,
            statusText: "Not Found",
          }),
      ),
    );

    let error: unknown;
    try {
      await new ApiClient().get("/api/tasks");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("HTTP 404 Not Found");
    expect((error as Error).message).not.toContain("<html>");
  });

  it("keeps JSON API error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Task queue disabled" }), { status: 409 })),
    );

    await expect(new ApiClient().post("/api/task-queue/run", {})).rejects.toThrow("Task queue disabled");
  });
});
