import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setSecurityHeaders, sendJson } from "../../src/web/server/http.js";
import { createHttpServer } from "../../src/web/server/httpServer.js";

// Mock response object for unit testing sendJson/setSecurityHeaders
class MockResponse extends http.ServerResponse {
  headersSent = false;
  statusCode = 200;
  _headers: Record<string, string | string[]> = {};
  _body = "";

  constructor() {
    super({} as any);
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this._headers[name.toLowerCase()] = String(value);
    return this;
  }

  getHeader(name: string) {
    return this._headers[name.toLowerCase()];
  }

  writeHead(statusCode: number, headers?: http.OutgoingHttpHeaders | string): this {
    this.statusCode = statusCode;
    if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) {
           this._headers[key.toLowerCase()] = String(value);
        }
      }
    }
    return this;
  }

  end(chunk?: any): this {
    if (chunk) {
      this._body = String(chunk);
    }
    return this;
  }
}

describe("web/server/http/securityHeaders", () => {
  it("setSecurityHeaders sets the expected headers", () => {
    const res = new MockResponse();
    setSecurityHeaders(res);

    assert.equal(res.getHeader("x-content-type-options"), "nosniff");
    assert.equal(res.getHeader("x-frame-options"), "DENY");
    assert.equal(res.getHeader("referrer-policy"), "strict-origin-when-cross-origin");
  });

  it("sendJson includes security headers", () => {
    const res = new MockResponse();
    sendJson(res, 200, { ok: true });

    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader("x-content-type-options"), "nosniff");
    assert.equal(res.getHeader("x-frame-options"), "DENY");
    assert.equal(res.getHeader("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(res.getHeader("content-type"), "application/json; charset=utf-8");
  });
});

describe("web/server/httpServer/securityHeaders", () => {
  let server: http.Server;

  before(() => {
    server = createHttpServer({
      handleApiRequest: async (req, res) => {
        // dummy handler that uses sendJson
        if (req.url?.startsWith("/api/test")) {
            sendJson(res, 200, { ok: true });
            return true;
        }
        return false;
      }
    });
  });

  async function dispatch(url: string): Promise<MockResponse> {
    const req = { method: "GET", url, headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;
    const res = new MockResponse();
    server.emit("request", req, res as any);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return res;
  }

  it("GET /healthz returns security headers", async () => {
    const res = await dispatch("/healthz");
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader("x-content-type-options"), "nosniff");
    assert.equal(res.getHeader("x-frame-options"), "DENY");
    assert.equal(res.getHeader("referrer-policy"), "strict-origin-when-cross-origin");
  });

  it("GET /random-path returns security headers (404/503)", async () => {
    const res = await dispatch("/random-path-that-does-not-exist.js");
    // Might be 503 if build dir missing, 404 if present but file does not exist.
    assert.ok(res.statusCode === 404 || res.statusCode === 503);
    assert.equal(res.getHeader("x-content-type-options"), "nosniff");
    assert.equal(res.getHeader("x-frame-options"), "DENY");
    assert.equal(res.getHeader("referrer-policy"), "strict-origin-when-cross-origin");
    // Ensure CORS * is gone
    assert.equal(res.getHeader("access-control-allow-origin"), undefined);
  });

  it("API response returns security headers", async () => {
    const res = await dispatch("/api/test");
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader("x-content-type-options"), "nosniff");
    assert.equal(res.getHeader("x-frame-options"), "DENY");
    assert.equal(res.getHeader("referrer-policy"), "strict-origin-when-cross-origin");
  });
});
