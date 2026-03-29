import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { listenServer } from "../../server/web/server/listenServer.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("web/server/listenServer", () => {
  it("rejects when the target host and port are already in use", async () => {
    const first = http.createServer((_req, res) => res.end("ok"));
    servers.push(first);
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", () => resolve()));

    const address = first.address();
    assert.ok(address && typeof address === "object");

    const second = http.createServer((_req, res) => res.end("ok"));
    servers.push(second);

    await assert.rejects(() => listenServer(second, address.port, "127.0.0.1"), {
      code: "EADDRINUSE",
    });
  });
});
