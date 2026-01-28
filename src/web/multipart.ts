export interface MultipartFilePart {
  fieldName: string;
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

function normalizeHeaderValue(value: string): string {
  return value.trim();
}

function parseBoundary(contentTypeHeader: string): string | null {
  const raw = String(contentTypeHeader ?? "").trim();
  if (!raw) return null;
  const [mediaType, ...params] = raw.split(";").map((p) => p.trim()).filter(Boolean);
  if (mediaType.toLowerCase() !== "multipart/form-data") return null;
  for (const p of params) {
    const match = /^boundary=(.+)$/i.exec(p);
    if (!match) continue;
    const value = match[1]!.trim();
    if (!value) return null;
    const unquoted = value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
    return unquoted.trim() || null;
  }
  return null;
}

function parsePartHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = raw.split("\r\n");
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = normalizeHeaderValue(line.slice(idx + 1));
    if (!key) continue;
    headers.set(key, value);
  }
  return headers;
}

function parseContentDisposition(value: string): { name: string | null; filename: string | null } {
  const raw = String(value ?? "").trim();
  if (!raw) return { name: null, filename: null };
  // Minimal parser: form-data; name="file"; filename="a.png"
  const parts = raw.split(";").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { name: null, filename: null };
  if (parts[0]!.toLowerCase() !== "form-data") return { name: null, filename: null };
  let name: string | null = null;
  let filename: string | null = null;
  for (const part of parts.slice(1)) {
    const [kRaw, vRaw] = part.split("=").map((s) => s.trim());
    if (!kRaw || vRaw == null) continue;
    const v = vRaw.startsWith("\"") && vRaw.endsWith("\"") ? vRaw.slice(1, -1) : vRaw;
    if (kRaw.toLowerCase() === "name") name = v || null;
    if (kRaw.toLowerCase() === "filename") filename = v || null;
  }
  return { name, filename };
}

export function extractMultipartFile(body: Buffer, contentTypeHeader: string, fieldName: string): MultipartFilePart | null {
  const boundary = parseBoundary(contentTypeHeader);
  if (!boundary) {
    throw new Error("Invalid multipart/form-data content-type");
  }
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const crlf = Buffer.from("\r\n", "utf8");
  const headerSep = Buffer.from("\r\n\r\n", "utf8");

  const first = body.indexOf(delimiter);
  if (first < 0) return null;
  let cursor = first;

  while (cursor >= 0 && cursor < body.length) {
    cursor += delimiter.length;
    if (cursor + 2 > body.length) return null;

    // End marker: `--boundary--`
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) {
      return null;
    }

    // Expect CRLF after boundary.
    if (!body.subarray(cursor, cursor + 2).equals(crlf)) {
      return null;
    }
    cursor += 2;

    const next = body.indexOf(delimiter, cursor);
    if (next < 0) return null;

    let part = body.subarray(cursor, next);
    // Drop trailing CRLF before delimiter.
    if (part.length >= 2 && part.subarray(part.length - 2).equals(crlf)) {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf(headerSep);
    if (headerEnd < 0) return null;
    const headerRaw = part.subarray(0, headerEnd).toString("utf8");
    const headers = parsePartHeaders(headerRaw);
    const disposition = headers.get("content-disposition") ?? "";
    const { name, filename } = parseContentDisposition(disposition);

    const data = part.subarray(headerEnd + headerSep.length);
    if (name === fieldName) {
      const contentType = headers.get("content-type") ?? null;
      return {
        fieldName,
        filename,
        contentType,
        data,
      };
    }

    cursor = next;
  }

  return null;
}

