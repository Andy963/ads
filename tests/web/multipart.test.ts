import { describe, it } from "node:test";
import assert from "node:assert";

import { extractMultipartFile } from "../../src/web/multipart.js";

function makeTinyPng(): Buffer {
  const buf = Buffer.alloc(8 + 4 + 4 + 13 + 4);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(1, 16);
  buf.writeUInt32BE(1, 20);
  return buf;
}

describe("web/multipart", () => {
  it("extractMultipartFile should parse file field", () => {
    const boundary = "----ads-test-boundary";
    const file = makeTinyPng();
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="a.png"\r\n` +
        `Content-Type: image/png\r\n` +
        `\r\n`,
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([head, file, tail]);
    const part = extractMultipartFile(body, `multipart/form-data; boundary=${boundary}`, "file");
    assert.ok(part);
    assert.equal(part.fieldName, "file");
    assert.equal(part.filename, "a.png");
    assert.equal(part.contentType, "image/png");
    assert.equal(part.data.length, file.length);
    assert.ok(part.data.equals(file));
  });
});

