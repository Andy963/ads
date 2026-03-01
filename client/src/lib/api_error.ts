export function formatApiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "Unknown error";

  // ApiClient throws `new Error(text)` where `text` is often a JSON string like `{"error":"..."}`.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
      const err = typeof parsed?.error === "string" ? parsed.error.trim() : "";
      if (err) return err;
      const msg = typeof parsed?.message === "string" ? parsed.message.trim() : "";
      if (msg) return msg;
    } catch {
      // ignore
    }
  }

  return trimmed;
}

export function looksLikeNotFound(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return m.includes("not found") || m.includes("http 404") || m.includes("\"error\":\"not found\"");
}

