import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";

import { createHttpServer } from "../../server/web/server/httpServer.js";
import { PROJECT_ROOT } from "../../server/utils/projectRoot.js";

describe("web/server/httpServer/pathTraversal", () => {
  let server: http.Server;
  let port: number;
  let testFileCreated = false;
  const testSecretFile = path.join(PROJECT_ROOT, "dist", "client-secrets", "test-secret.txt");

  before(async () => {
    // Make sure dist/client-secrets exists
    const secretsDir = path.dirname(testSecretFile);
    if (!fs.existsSync(secretsDir)) {
      fs.mkdirSync(secretsDir, { recursive: true });
    }
    fs.writeFileSync(testSecretFile, "THIS IS A SECRET FILE");
    testFileCreated = true;

    server = createHttpServer({});
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  after(() => {
    if (server) {
      server.close();
    }
    if (testFileCreated) {
      try {
        fs.unlinkSync(testSecretFile);
      } catch {
        // ignore
      }
    }
  });

  async function request(pathStr: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve) => {
      http.get(`http://localhost:${port}${pathStr}`, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 500, body });
        });
      });
    });
  }

  it("blocks simple path traversal using ..", async () => {
    const res = await request("/../client-secrets/test-secret.txt");
    assert.ok(res.statusCode === 403 || res.statusCode === 404);
    assert.ok(!res.body.includes("SECRET FILE"));
  });

  it("blocks URL-encoded path traversal %2e%2e", async () => {
    const res = await request("/%2e%2e/client-secrets/test-secret.txt");
    assert.ok(res.statusCode === 403 || res.statusCode === 404);
    assert.ok(!res.body.includes("SECRET FILE"));
  });

  it("blocks heavily URL-encoded path traversal", async () => {
    const res = await request("/%2e%2e%2f%2e%2e%2fclient-secrets/test-secret.txt");
    assert.ok(res.statusCode === 403 || res.statusCode === 404);
    assert.ok(!res.body.includes("SECRET FILE"));
  });

  it("returns 400 Bad Request for malformed URI", async () => {
    const res = await request("/%2e%2e%2f%c0%af%c0%afclient-secrets/test-secret.txt");
    assert.equal(res.statusCode, 400);
    assert.equal(res.body, "Bad Request");
  });
});
