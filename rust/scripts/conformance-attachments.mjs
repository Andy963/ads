#!/usr/bin/env node
/**
 * Black-box conformance for multipart image attachments and raw image serving.
 */
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, assertJson, compare, loginAs, startServerPair } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const rustDir = path.join(root, "rust");

function pngBytes() {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(640, 16);
  bytes.writeUInt32BE(480, 20);
  Buffer.from([8, 6, 0, 0, 0]).copy(bytes, 24);
  return bytes;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function upload(baseUrl, cookie, bytes, options = {}) {
  const form = new FormData();
  const field = options.field ?? "file";
  form.append(
    field,
    new Blob([bytes], { type: options.contentType ?? "image/png" }),
    options.filename ?? "shot.png",
  );
  const response = await fetch(`${baseUrl}/api/attachments/images`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

async function postText(baseUrl, cookie, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { cookie, "content-type": "text/plain" },
    body,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

async function raw(baseUrl, cookie, id, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/api/attachments/${encodeURIComponent(id)}/raw`, {
    headers: { cookie, ...extraHeaders },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
  };
}

function compareRawHeaders(label, nodeResult, rustResult) {
  for (const name of ["content-type", "content-length", "cache-control", "etag"]) {
    assert(
      nodeResult.headers.get(name) === rustResult.headers.get(name),
      `${label}: ${name} ${nodeResult.headers.get(name)} != ${rustResult.headers.get(name)}`,
    );
  }
}

async function main() {
  const pair = await startServerPair({ root, rustDir });
  try {
    const nodeLogin = await loginAs(pair.nodeBase, pair.username, pair.password);
    const rustLogin = await loginAs(pair.rustBase, pair.username, pair.password);
    const bytes = pngBytes();
    const expectedSha = sha256(bytes);

    const nodeUpload = await upload(pair.nodeBase, nodeLogin.cookie, bytes);
    const rustUpload = await upload(pair.rustBase, rustLogin.cookie, bytes);
    assert(nodeUpload.status === 201, `node upload status ${nodeUpload.status}`);
    assert(rustUpload.status === 201, `rust upload status ${rustUpload.status}`);
    await compare("attachment-upload", nodeUpload, rustUpload, { masks: ["id", "url"] });
    assertJson(rustUpload.body.sha256, expectedSha, "attachment-upload sha256");
    assertJson(rustUpload.body.width, 640, "attachment-upload width");
    assertJson(rustUpload.body.height, 480, "attachment-upload height");
    assertJson(rustUpload.body.contentType, "image/png", "attachment-upload contentType");
    assertJson(rustUpload.body.sizeBytes, bytes.length, "attachment-upload sizeBytes");

    const nodeRaw = await raw(pair.nodeBase, nodeLogin.cookie, nodeUpload.body.id);
    const rustRaw = await raw(pair.rustBase, rustLogin.cookie, rustUpload.body.id);
    assert(nodeRaw.status === 200, `node raw status ${nodeRaw.status}`);
    assert(rustRaw.status === 200, `rust raw status ${rustRaw.status}`);
    compareRawHeaders("attachment-raw", nodeRaw, rustRaw);
    assert(nodeRaw.bytes.equals(bytes), "node raw bytes differ");
    assert(rustRaw.bytes.equals(bytes), "rust raw bytes differ");

    const nodeCached = await raw(pair.nodeBase, nodeLogin.cookie, nodeUpload.body.id, {
      "if-none-match": nodeRaw.headers.get("etag"),
    });
    const rustCached = await raw(pair.rustBase, rustLogin.cookie, rustUpload.body.id, {
      "if-none-match": rustRaw.headers.get("etag"),
    });
    assert(nodeCached.status === 304, `node cached status ${nodeCached.status}`);
    assert(rustCached.status === 304, `rust cached status ${rustCached.status}`);
    compareRawHeaders("attachment-raw-cached", nodeCached, rustCached);

    const duplicateNode = await upload(pair.nodeBase, nodeLogin.cookie, bytes);
    const duplicateRust = await upload(pair.rustBase, rustLogin.cookie, bytes);
    assertJson(duplicateRust.body.id, rustUpload.body.id, "duplicate upload id");

    const missingNode = await upload(pair.nodeBase, nodeLogin.cookie, bytes, { field: "other" });
    const missingRust = await upload(pair.rustBase, rustLogin.cookie, bytes, { field: "other" });
    await compare("attachment-missing-field", missingNode, missingRust);

    const emptyNode = await upload(pair.nodeBase, nodeLogin.cookie, Buffer.alloc(0));
    const emptyRust = await upload(pair.rustBase, rustLogin.cookie, Buffer.alloc(0));
    await compare("attachment-empty-file", emptyNode, emptyRust);

    const unsupportedNode = await upload(pair.nodeBase, nodeLogin.cookie, Buffer.from("plain"), {
      filename: "note.txt",
      contentType: "text/plain",
    });
    const unsupportedRust = await upload(pair.rustBase, rustLogin.cookie, Buffer.from("plain"), {
      filename: "note.txt",
      contentType: "text/plain",
    });
    await compare("attachment-unsupported", unsupportedNode, unsupportedRust);

    const missingRawNode = await raw(pair.nodeBase, nodeLogin.cookie, "missing");
    const missingRawRust = await raw(pair.rustBase, rustLogin.cookie, "missing");
    assertJson(missingRawNode.status, 404, "node missing raw");
    assertJson(missingRawRust.status, 404, "rust missing raw");

    const unauthenticatedNode = await upload(pair.nodeBase, "", bytes);
    const unauthenticatedRust = await upload(pair.rustBase, "", bytes);
    await compare("attachment-unauthenticated", unauthenticatedNode, unauthenticatedRust);

    await compare(
      "attachment-workspace-denied",
      await postText(pair.nodeBase, nodeLogin.cookie, "/api/attachments/images?workspace=%2Fetc", "x"),
      await postText(pair.rustBase, rustLogin.cookie, "/api/attachments/images?workspace=%2Fetc", "x"),
    );

    console.log("attachment conformance: ok");
  } finally {
    await pair.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
