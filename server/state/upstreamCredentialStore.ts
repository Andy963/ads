import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { normalizeUpstreamBaseUrl } from "../utils/upstreamUrl.js";

export type UpstreamCredentials = { baseUrl: string; provider: string; apiKey: string };
export type UpstreamCredentialMetadata = Omit<UpstreamCredentials, "apiKey"> & { hasApiKey: boolean };

const namespace = "web_upstream_credentials";
const envelopeSchema = z.object({
  version: z.literal(1),
  baseUrl: z.string().min(1).max(2048),
  provider: z.string().min(1).max(128),
  iv: z.string().max(32),
  tag: z.string().max(32),
  ciphertext: z.string().min(1).max(32_768),
}).strict();

function privateKeyFile(filename: string): Buffer {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(filename, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Upstream encryption key must be a private file");
    const key = fs.readFileSync(fd);
    if (key.length !== 32) throw new Error("Invalid upstream encryption key");
    return key;
  } finally {
    fs.closeSync(fd);
  }
}

export function createUpstreamCredentialStore(db: Database, options: { pepper?: string; keyPath?: string } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS kv_state (
    namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
  )`);
  const read = db.prepare("SELECT value FROM kv_state WHERE namespace = ? AND key = ?");
  const write = db.prepare(`INSERT INTO kv_state (namespace, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const encryptionKey = (): Buffer => {
    const pepper = (options.pepper ?? process.env.ADS_WEB_SESSION_PEPPER ?? "").trim();
    if (pepper) return Buffer.from(hkdfSync("sha256", pepper, "", "ads:upstream-credentials:v1", 32));
    const directory = db.name && db.name !== ":memory:" ? path.dirname(db.name) : resolveAdsStateDir();
    return privateKeyFile(options.keyPath ?? path.join(directory, "upstream-credentials.key"));
  };
  const ownerKey = (owner: string): string => {
    if (!owner?.trim()) throw new Error("An authenticated owner is required");
    return owner;
  };
  const envelope = (owner: string) => {
    const row = read.get(namespace, ownerKey(owner)) as { value: string } | undefined;
    if (!row) return null;
    try { return envelopeSchema.parse(JSON.parse(row.value)); }
    catch { throw new Error("Saved upstream configuration is invalid; re-enter the endpoint and API key"); }
  };
  const aad = (owner: string, value: { baseUrl: string; provider: string }): Buffer =>
    Buffer.from(JSON.stringify([namespace, owner, value.baseUrl, value.provider]));

  const getMetadata = (owner: string): UpstreamCredentialMetadata | null => {
    const value = envelope(owner);
    return value ? { baseUrl: value.baseUrl, provider: value.provider, hasApiKey: true } : null;
  };
  const getCredentials = (owner: string): UpstreamCredentials | null => {
    const value = envelope(owner);
    if (!value) return null;
    try {
      const iv = Buffer.from(value.iv, "base64");
      const tag = Buffer.from(value.tag, "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
      decipher.setAAD(aad(owner, value));
      decipher.setAuthTag(tag);
      const apiKey = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
      return { baseUrl: value.baseUrl, provider: value.provider, apiKey };
    } catch {
      throw new Error("Saved upstream credentials cannot be decrypted; re-enter the API key");
    }
  };
  const save = (owner: string, input: UpstreamCredentials): void => {
    ownerKey(owner);
    const value = { baseUrl: normalizeUpstreamBaseUrl(input.baseUrl), provider: input.provider.trim() || "openai" };
    const key = input.apiKey.trim();
    if (!key || Buffer.byteLength(key) > 16_384 || value.provider.length > 128) throw new Error("Invalid upstream credentials");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
    cipher.setAAD(aad(owner, value));
    const ciphertext = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
    // Restrict the database and its already-open WAL companions before the
    // encrypted record is written. No plaintext secret ever reaches SQLite.
    if (db.name && db.name !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.chmodSync(db.name + suffix, 0o600); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    write.run(namespace, owner, JSON.stringify({ version: 1, ...value, iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), Date.now());
  };
  return { getMetadata, getCredentials, save };
}

export type UpstreamCredentialStore = ReturnType<typeof createUpstreamCredentialStore>;
