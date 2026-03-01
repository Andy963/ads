import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createHttpServer } from "../../server/web/server/httpServer.js";

describe("web/server/security", () => {
  let server: http.Server;
  const errorCalls: unknown[][] = [];

  beforeEach(async () => {
    errorCalls.length = 0;
    server = createHttpServer({
      handleApiRequest: async (req, res) => {
        if (req.url === "/api/test") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
          return true;
        }
        if (req.url === "/api/error") {
          throw new Error("Sensitive info leak");
        }
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Not Found" }));
        return true;
      },
      logger: {
        error(message: string, ...args: unknown[]) {
          errorCalls.push([message, ...args]);
        },
      },
    });
  });

  function createMockResponse(): {
    statusCode: number;
    headersSent: boolean;
    headers: Record<string, string>;
    body: string;
    setHeader: (name: string, value: unknown) => void;
    getHeader: (name: string) => string | undefined;
    writeHead: (statusCode: number, headers?: http.OutgoingHttpHeaders | string) => any;
    end: (chunk?: unknown) => any;
    destroy: () => void;
  } {
    const store: Record<string, string> = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      headers: store,
      body: "",
      setHeader(name: string, value: unknown) {
        store[String(name).toLowerCase()] = String(value);
      },
      getHeader(name: string) {
        return store[String(name).toLowerCase()];
      },
      writeHead(statusCode: number, headers?: http.OutgoingHttpHeaders | string) {
        res.statusCode = statusCode;
        if (headers && typeof headers === "object") {
          for (const [key, value] of Object.entries(headers)) {
            if (value !== undefined) {
              store[String(key).toLowerCase()] = String(value);
            }
          }
        }
        res.headersSent = true;
        return res;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) {
          res.body = String(chunk);
        }
        res.headersSent = true;
        return res;
      },
      destroy() {
        // no-op
      },
    };
    return res;
  }

  async function dispatch(url: string): Promise<ReturnType<typeof createMockResponse>> {
    const req = { method: "GET", url, headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;
    const res = createMockResponse();
    server.emit("request", req, res as any);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return res;
  }

  it("sets security headers on API responses even when handler does not call sendJson", async () => {
    const res = await dispatch("/api/test");
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader("x-content-type-options"), "nosniff");
    assert.equal(res.getHeader("x-frame-options"), "DENY");
    assert.equal(res.getHeader("referrer-policy"), "strict-origin-when-cross-origin");
  });

  it("sanitizes unhandled API errors and logs the full error server-side", async () => {
    const res = await dispatch("/api/error");
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.includes("Sensitive info leak"));
    const body = JSON.parse(res.body) as { error: string };
    assert.equal(body.error, "Internal Server Error");

    assert.ok(errorCalls.length >= 1);
    assert.equal(errorCalls[0]?.[0], "API Error");
  });
});
