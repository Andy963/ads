import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createHttpServer } from "../../src/web/server/httpServer.js";

describe("web/server/security", () => {
  let server: http.Server;
  let baseUrl: string;
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

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it("sets security headers on API responses even when handler does not call sendJson", async () => {
    const res = await fetch(`${baseUrl}/api/test`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  });

  it("sanitizes unhandled API errors and logs the full error server-side", async () => {
    const res = await fetch(`${baseUrl}/api/error`);
    assert.equal(res.status, 500);
    const raw = await res.text();
    assert.ok(!raw.includes("Sensitive info leak"));
    const body = JSON.parse(raw) as { error: string };
    assert.equal(body.error, "Internal Server Error");

    assert.ok(errorCalls.length >= 1);
    assert.equal(errorCalls[0]?.[0], "API Error");
  });
});
