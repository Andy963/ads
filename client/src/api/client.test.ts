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
      await new ApiClient().get("/api/models");
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
      vi.fn(async () => new Response(JSON.stringify({ error: "Models unavailable" }), { status: 409 })),
    );

    await expect(new ApiClient().post("/api/models", {})).rejects.toThrow("Models unavailable");
  });

  it("sends JSON PUT requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBe(JSON.stringify({ prompt: "updated" }));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ApiClient().put("/api/lane-prompts/advisor", { prompt: "updated" })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
