import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttpServer } from "../../server/web/server/httpServer.js";

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

describe("web/server/httpServer/pathTraversal", () => {
  let server: http.Server;

  before(() => {
    server = createHttpServer({
      handleApiRequest: async () => false,
    });
  });

  async function dispatch(url: string): Promise<MockResponse> {
    const req = { method: "GET", url, headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;
    const res = new MockResponse();
    server.emit("request", req, res as any);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return res;
  }

  it("rejects malformed percent-encoding with 400 Bad Request", async () => {
    const res = await dispatch("/%zz");
    assert.equal(res.statusCode, 400);
  });

  it("rejects incomplete UTF-8 percent-encoding with 400 Bad Request", async () => {
    const res = await dispatch("/%E0%A4");
    assert.equal(res.statusCode, 400);
  });

  it("accepts valid percent-encoding and proceeds (404 for missing asset)", async () => {
    const res = await dispatch("/foo%2etxt");
    assert.notEqual(res.statusCode, 400);
    assert.equal(res.statusCode, 404);
  });

  it("does not serve files outside dist via encoded dot-dot", async () => {
    const res = await dispatch("/%2e%2e%2f%2e%2e%2fetc%2fpasswd.txt");
    assert.ok(res.statusCode === 403 || res.statusCode === 404, `got ${res.statusCode}`);
    assert.equal(res._body.includes("root:"), false);
  });

  it("does not serve files outside dist via literal dot-dot", async () => {
    const res = await dispatch("/../../etc/passwd.txt");
    assert.ok(res.statusCode === 403 || res.statusCode === 404, `got ${res.statusCode}`);
    assert.equal(res._body.includes("root:"), false);
  });
});
