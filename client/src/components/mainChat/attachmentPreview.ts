export type ComposerImagePreview = {
  src: string;
  href: string;
};

const MARKDOWN_IMAGE_RE = /^!\[[^\]]*\]\((.+)\)$/s;
const TAGGED_IMAGE_RE = /^\[(?:image|local_image|attachment)\s*:\s*([^\]]+)\]$/i;
const ATTACHMENT_SCHEME_RE = /^attachment:\/\/(.+)$/i;
const ATTACHMENT_COLON_RE = /^attachment:(.+)$/i;
const ATTACHMENT_PATH_RE = /^\/api\/attachments\/([^/?#]+)(?:\/raw)?$/i;
const ATTACHMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTACHMENT_SLUG_RE = /^(?:att|attachment)-[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function hasScheme(input: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripWrapper(value: string): string {
  let next = String(value ?? "").trim();
  for (let i = 0; i < 3; i++) {
    if (!next) break;
    const first = next[0];
    const last = next[next.length - 1];
    const wrapped =
      (first === "<" && last === ">") ||
      (first === "\"" && last === "\"") ||
      (first === "'" && last === "'");
    if (!wrapped) break;
    next = next.slice(1, -1).trim();
  }
  return next;
}

function extractCandidate(raw: string): string {
  let value = stripWrapper(raw);
  if (!value) return "";

  const markdown = MARKDOWN_IMAGE_RE.exec(value);
  if (markdown?.[1]) {
    value = stripWrapper(markdown[1]);
  }

  const tagged = TAGGED_IMAGE_RE.exec(value);
  if (tagged?.[1]) {
    value = stripWrapper(tagged[1]);
  }

  return stripWrapper(value);
}

function normalizeAttachmentApiUrl(candidate: string): string | null {
  const trimmed = String(candidate ?? "").trim();
  if (!trimmed) return null;

  try {
    const absolute = hasScheme(trimmed);
    const parsed = new URL(trimmed, "http://localhost");
    const match = ATTACHMENT_PATH_RE.exec(parsed.pathname);
    if (!match?.[1]) return null;

    const id = safeDecodeURIComponent(match[1]).trim();
    if (!id) return null;
    const normalizedPath = `/api/attachments/${encodeURIComponent(id)}/raw`;

    if (absolute) {
      parsed.pathname = normalizedPath;
      return parsed.toString();
    }
    return `${normalizedPath}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function extractAttachmentId(candidate: string): string | null {
  const trimmed = String(candidate ?? "").trim();
  if (!trimmed) return null;

  const fromAttachmentScheme = ATTACHMENT_SCHEME_RE.exec(trimmed)?.[1] ?? ATTACHMENT_COLON_RE.exec(trimmed)?.[1] ?? "";
  if (fromAttachmentScheme.trim()) {
    const id = stripWrapper(fromAttachmentScheme).trim();
    return id || null;
  }

  if (ATTACHMENT_UUID_RE.test(trimmed) || ATTACHMENT_SLUG_RE.test(trimmed)) {
    return trimmed;
  }

  const normalizedApiPath = normalizeAttachmentApiUrl(trimmed);
  if (normalizedApiPath) {
    try {
      const parsed = new URL(normalizedApiPath, "http://localhost");
      const match = ATTACHMENT_PATH_RE.exec(parsed.pathname);
      if (!match?.[1]) return null;
      const id = safeDecodeURIComponent(match[1]).trim();
      return id || null;
    } catch {
      return null;
    }
  }

  return null;
}

function looksLikeFilesystemPath(candidate: string): boolean {
  const trimmed = String(candidate ?? "").trim();
  if (!trimmed) return false;
  if (/^file:\/\//i.test(trimmed)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (/^\\\\/.test(trimmed)) return true;
  if (/^\/(?:home|users|private|var|tmp|mnt|etc)\//i.test(trimmed)) return true;
  return false;
}

export function normalizeComposerImageSource(raw: string): string {
  const candidate = extractCandidate(raw);
  if (!candidate) return "";

  const lowered = candidate.toLowerCase();
  if (lowered.startsWith("data:image/")) {
    return candidate;
  }
  if (lowered.startsWith("blob:")) {
    return candidate;
  }

  const normalizedApi = normalizeAttachmentApiUrl(candidate);
  if (normalizedApi) {
    return normalizedApi;
  }

  const attachmentId = extractAttachmentId(candidate);
  if (attachmentId) {
    return `/api/attachments/${encodeURIComponent(attachmentId)}/raw`;
  }

  if (looksLikeFilesystemPath(candidate)) {
    return "";
  }

  if (/^https?:\/\//i.test(candidate) || candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../")) {
    return candidate;
  }

  return "";
}

function appendTokenQuery(url: string, token?: string): string {
  const source = String(url ?? "").trim();
  const normalizedToken = String(token ?? "").trim();
  if (!source || !normalizedToken) return source;

  const lowered = source.toLowerCase();
  if (lowered.startsWith("data:") || lowered.startsWith("blob:") || lowered.startsWith("file:")) {
    return source;
  }

  try {
    const absolute = hasScheme(source);
    const parsed = new URL(source, "http://localhost");
    if (!parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", normalizedToken);
    }
    if (absolute) {
      return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const joiner = source.includes("?") ? "&" : "?";
    return `${source}${joiner}token=${encodeURIComponent(normalizedToken)}`;
  }
}

export function resolveComposerImagePreview(raw: string, options?: { apiToken?: string }): ComposerImagePreview | null {
  const normalized = normalizeComposerImageSource(raw);
  if (!normalized) return null;
  const finalUrl = appendTokenQuery(normalized, options?.apiToken);
  return {
    src: finalUrl,
    href: finalUrl,
  };
}
