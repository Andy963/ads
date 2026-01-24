import crypto from "node:crypto";

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function workspaceNamespaceFor(workspaceRoot: string): string {
  // Keep it short for readability/logging, but stable for the same workspace path.
  return sha256Hex(String(workspaceRoot)).slice(0, 12);
}

