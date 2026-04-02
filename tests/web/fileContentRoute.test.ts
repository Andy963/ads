import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleFileRoutes } from "../../server/web/server/api/routes/files.js";

type FakeReq = {
  method: string;
  headers: Record<string, string>;
};

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body?: string) => void;
};

function createReq(method: string): FakeReq {
  return { method, headers: {} };
}

function createRes(): FakeRes {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = body;
    },
  };
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}

describe("web/api/files", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-file-preview-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns a centered preview slice for a targeted line", async () => {
    const filePath = path.join(tmpDir, "src", "demo.py");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = Array.from({ length: 900 }, (_, idx) => `line ${idx + 1}`);
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");

    const req = createReq("GET");
    const res = createRes();
    const url = new URL(
      `http://localhost/api/files/content?workspace=${encodeURIComponent(tmpDir)}&path=${encodeURIComponent(filePath)}&line=450`,
    );

    const handled = await handleFileRoutes(
      { req: req as any, res: res as any, url, pathname: "/api/files/content", auth: {} as any } as any,
      { resolveTaskContext: () => ({ workspaceRoot: tmpDir }) as any },
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = parseJson<{
      path: string;
      totalLines: number;
      startLine: number;
      endLine: number;
      line: number | null;
      content: string;
      truncated: boolean;
    }>(res.body);
    assert.equal(body.path, path.resolve(filePath));
    assert.equal(body.totalLines, 900);
    assert.equal(body.line, 450);
    assert.equal(body.truncated, true);
    assert.ok(body.startLine <= 450);
    assert.ok(body.endLine >= 450);
    assert.match(body.content, /line 450/);
  });

  it("returns a requested preview window and clamps it to the file bounds", async () => {
    const filePath = path.join(tmpDir, "src", "demo.py");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = Array.from({ length: 900 }, (_, idx) => `line ${idx + 1}`);
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");

    const req = createReq("GET");
    const res = createRes();
    const url = new URL(
      `http://localhost/api/files/content?workspace=${encodeURIComponent(tmpDir)}&path=${encodeURIComponent(filePath)}&line=450&startLine=850`,
    );

    const handled = await handleFileRoutes(
      { req: req as any, res: res as any, url, pathname: "/api/files/content", auth: {} as any } as any,
      { resolveTaskContext: () => ({ workspaceRoot: tmpDir }) as any },
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = parseJson<{
      startLine: number;
      endLine: number;
      line: number | null;
      content: string;
      truncated: boolean;
    }>(res.body);
    assert.equal(body.startLine, 501);
    assert.equal(body.endLine, 900);
    assert.equal(body.line, 450);
    assert.equal(body.truncated, true);
    assert.doesNotMatch(body.content, /line 450/);
    assert.match(body.content, /^line 501/);
    assert.match(body.content, /line 900$/);
  });

  it("rejects paths outside the current workspace", async () => {
    const outsideFile = path.join(os.tmpdir(), `ads-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsideFile, "secret", "utf8");

    const req = createReq("GET");
    const res = createRes();
    const url = new URL(
      `http://localhost/api/files/content?workspace=${encodeURIComponent(tmpDir)}&path=${encodeURIComponent(outsideFile)}`,
    );

    try {
      const handled = await handleFileRoutes(
        { req: req as any, res: res as any, url, pathname: "/api/files/content", auth: {} as any } as any,
        { resolveTaskContext: () => ({ workspaceRoot: tmpDir }) as any },
      );
      assert.equal(handled, true);
      assert.equal(res.statusCode, 403);
      assert.match(res.body, /workspace/);
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects binary files", async () => {
    const filePath = path.join(tmpDir, "bin.dat");
    fs.writeFileSync(filePath, Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]));

    const req = createReq("GET");
    const res = createRes();
    const url = new URL(
      `http://localhost/api/files/content?workspace=${encodeURIComponent(tmpDir)}&path=${encodeURIComponent(filePath)}`,
    );

    const handled = await handleFileRoutes(
      { req: req as any, res: res as any, url, pathname: "/api/files/content", auth: {} as any } as any,
      { resolveTaskContext: () => ({ workspaceRoot: tmpDir }) as any },
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 415);
    assert.match(res.body, /二进制/);
  });
});
