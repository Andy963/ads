import crypto from "node:crypto";

function toBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function deriveProjectSessionId(workspaceRoot: string): string {
  const normalized = String(workspaceRoot ?? "").trim();
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return toBase64Url(digest);
}

