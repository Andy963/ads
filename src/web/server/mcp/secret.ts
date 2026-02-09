import crypto from "node:crypto";

let cachedPepper: string | null = null;

export function resolveMcpPepper(): string {
  if (cachedPepper) {
    return cachedPepper;
  }
  const fromEnv = String(process.env.ADS_MCP_PEPPER ?? "").trim();
  if (fromEnv) {
    cachedPepper = fromEnv;
    return cachedPepper;
  }
  const sessionPepper = String(process.env.ADS_WEB_SESSION_PEPPER ?? "").trim();
  if (sessionPepper) {
    cachedPepper = sessionPepper;
    return cachedPepper;
  }
  cachedPepper = crypto.randomBytes(32).toString("base64url");
  return cachedPepper;
}

export function resetMcpPepperForTests(): void {
  cachedPepper = null;
}

