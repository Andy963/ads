import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectImageInfo } from "../../src/attachments/images.js";
import { AttachmentStore } from "../../src/attachments/store.js";
import { getDatabase, resetDatabaseForTests } from "../../src/storage/database.js";

function makeTinyPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(8 + 4 + 4 + 13 + 4);
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (13)
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // Remaining IHDR bytes can be zeros for our parser.
  return buf;
}

function makeTinyJpeg(width: number, height: number): Buffer {
  // SOI
  const soi = Buffer.from([0xff, 0xd8]);
  // APP0: minimal JFIF-like segment (not parsed; just to look realistic)
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  // SOF0 (baseline): length 17, precision 8, height, width, components 3
  const sof0 = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
  ]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, eoi]);
}

function makeTinyWebpVp8x(width: number, height: number): Buffer {
  const w = width - 1;
  const h = height - 1;
  const vp8x = Buffer.alloc(8 + 10);
  vp8x.write("VP8X", 0, "ascii");
  vp8x.writeUInt32LE(10, 4);
  // features + reserved
  vp8x[8] = 0;
  vp8x[9] = 0;
  vp8x[10] = 0;
  vp8x[11] = 0;
  // width-1 (24-bit LE)
  vp8x[12] = w & 0xff;
  vp8x[13] = (w >> 8) & 0xff;
  vp8x[14] = (w >> 16) & 0xff;
  // height-1 (24-bit LE)
  vp8x[15] = h & 0xff;
  vp8x[16] = (h >> 8) & 0xff;
  vp8x[17] = (h >> 16) & 0xff;

  const riffHeader = Buffer.alloc(12);
  riffHeader.write("RIFF", 0, "ascii");
  // file size (excluding "RIFF" + size itself)
  riffHeader.writeUInt32LE(4 + vp8x.length, 4);
  riffHeader.write("WEBP", 8, "ascii");
  return Buffer.concat([riffHeader, vp8x]);
}

describe("attachments/images", () => {
  it("detectImageInfo: png", () => {
    const buf = makeTinyPng(2, 3);
    const info = detectImageInfo(buf);
    assert.ok(info);
    assert.equal(info.contentType, "image/png");
    assert.equal(info.ext, "png");
    assert.equal(info.width, 2);
    assert.equal(info.height, 3);
  });

  it("detectImageInfo: jpeg", () => {
    const buf = makeTinyJpeg(32, 16);
    const info = detectImageInfo(buf);
    assert.ok(info);
    assert.equal(info.contentType, "image/jpeg");
    assert.equal(info.ext, "jpg");
    assert.equal(info.width, 32);
    assert.equal(info.height, 16);
  });

  it("detectImageInfo: webp", () => {
    const buf = makeTinyWebpVp8x(10, 20);
    const info = detectImageInfo(buf);
    assert.ok(info);
    assert.equal(info.contentType, "image/webp");
    assert.equal(info.ext, "webp");
    assert.equal(info.width, 10);
    assert.equal(info.height, 20);
  });
});

describe("attachments/store", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-attachments-test-"));
    dbPath = path.join(tmpDir, "test.db");
    process.env.ADS_DATABASE_PATH = dbPath;
    resetDatabaseForTests();
  });

  afterEach(() => {
    resetDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("createOrGetImageAttachment should dedupe by sha256", () => {
    const store = new AttachmentStore();
    const sha = "a".repeat(64);
    const a = store.createOrGetImageAttachment({
      contentType: "image/png",
      sizeBytes: 10,
      width: 1,
      height: 1,
      sha256: sha,
      storageKey: `attachments/${sha.slice(0, 2)}/${sha}.png`,
      now: 123,
    });
    const b = store.createOrGetImageAttachment({
      contentType: "image/png",
      sizeBytes: 10,
      width: 1,
      height: 1,
      sha256: sha,
      storageKey: `attachments/${sha.slice(0, 2)}/${sha}.png`,
      now: 456,
    });
    assert.equal(a.id, b.id);
    assert.equal(a.sha256, sha);
  });

  it("assignAttachmentsToTask should require task to exist (FK)", () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, created_at) VALUES (?, ?, ?, ?)`,
    ).run("task-1", "t", "p", 1);

    const store = new AttachmentStore();
    const sha = "b".repeat(64);
    const att = store.createOrGetImageAttachment({
      contentType: "image/png",
      sizeBytes: 10,
      width: 1,
      height: 1,
      sha256: sha,
      storageKey: `attachments/${sha.slice(0, 2)}/${sha}.png`,
      now: 1,
    });

    store.assignAttachmentsToTask("task-1", [att.id]);
    const updated = store.getAttachment(att.id);
    assert.ok(updated);
    assert.equal(updated.taskId, "task-1");
  });
});

