import crypto from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const derived = crypto.scryptSync(password, salt, 32, { N, r, p });
  return `scrypt$N=${N}$r=${r}$p=${p}$salt=${base64url(salt)}$hash=${base64url(derived)}`;
}

type ParsedScrypt = {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
};

function parseScryptHash(stored: string): ParsedScrypt | null {
  const raw = String(stored ?? "").trim();
  if (!raw.startsWith("scrypt$")) {
    return null;
  }
  const parts = raw.split("$").slice(1);
  const params = new Map<string, string>();
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k || !v) continue;
    params.set(k, v);
  }
  const N = Number(params.get("N"));
  const r = Number(params.get("r"));
  const p = Number(params.get("p"));
  const saltRaw = params.get("salt");
  const hashRaw = params.get("hash");
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !saltRaw || !hashRaw) {
    return null;
  }
  try {
    const salt = fromBase64url(saltRaw);
    const hash = fromBase64url(hashRaw);
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}

export function verifyPasswordScrypt(password: string, stored: string): boolean {
  const parsed = parseScryptHash(stored);
  if (!parsed) {
    return false;
  }
  try {
    const derived = crypto.scryptSync(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });
    return crypto.timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

