function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  return trimmed.replace(/\/+$/g, "");
}

export function resolveGroqKey(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.GROQ_API_KEY ?? "").trim();
}

export function resolveGroqBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeBaseUrl(
    String(
      env.GROQ_BASE_URL ??
        env.GROQ_API_BASE ??
        env.GROQ_OPENAI_BASE_URL ??
        "https://api.groq.com/openai/v1",
    ),
  );
}

