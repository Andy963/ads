import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setSecurityHeaders, sendJson } from "../../server/web/server/http.js";
import { createHttpServer } from "../../server/web/server/httpServer.js";

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

  async function dispatchRaw(url: string): Promise<ReturnType<typeof createMockResponse>> {
    const req = { method: "GET", url, headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;
    const res = createMockResponse();
    server.emit("request", req, res as any);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return res;
  }

  it("sets security headers on API responses even when handler does not call sendJson", async () => {
    const res = await dispatchRaw("/api/test");
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader("x-content-type-options"), "nosniff");
    assert.equal(res.getHeader("x-frame-options"), "DENY");
    assert.equal(res.getHeader("referrer-policy"), "strict-origin-when-cross-origin");
  });

  it("sanitizes unhandled API errors and logs the full error server-side", async () => {
    const res = await dispatchRaw("/api/error");
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.includes("Sensitive info leak"));
    const body = JSON.parse(res.body) as { error: string };
    assert.equal(body.error, "Internal Server Error");

    assert.ok(errorCalls.length >= 1);
    assert.equal(errorCalls[0]?.[0], "API Error");
  });
});
