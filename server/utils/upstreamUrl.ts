export function normalizeUpstreamBaseUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Upstream base URL is required");
  let url: URL;
  try {
    url = new URL(value.startsWith("//") ? `https:${value}` : value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("Invalid upstream base URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Upstream base URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Upstream base URL must not contain credentials");
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:responses|chat\/completions|completions|models)$/, "");
  url.pathname = pathname || "/v1";
  url.search = "";
  url.hash = "";
  if (url.href.length > 2048) throw new Error("Upstream base URL is too long");
  return url.toString();
}

export function buildModelsEndpoint(input: string): string {
  return `${normalizeUpstreamBaseUrl(input)}/models`;
}
