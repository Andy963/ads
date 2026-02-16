import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttpServer } from "../../src/web/server/httpServer.js";

describe("web/server/security", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    // Pass a dummy logger if needed
    // The logger is optional in my planned implementation
    server = createHttpServer({
      handleApiRequest: async (req, res) => {
        if (req.url === "/api/test") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return true;
        }
        if (req.url === "/api/error") {
            throw new Error("Sensitive info leak");
        }
        return false;
      },
      logger: {
        error: () => {},
        info: () => {},
        warn: () => {},
        debug: () => {},
        log: () => {},
        child: () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {}, log: () => {} } as any),
        setLevel: () => {}
      } as any
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
            port = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(() => {
    server.close();
  });

  it("sets security headers on API responses", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/test`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "SAMEORIGIN");
    assert.equal(res.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  });

  it("does not leak stack traces on error", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/error`);
    assert.equal(res.status, 500);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "Internal Server Error");
    // Ensure "Sensitive info leak" is NOT in the response body
    // Although fetching as json already verified error property
    // let's double check content
  });
});
