export function buildPromptHistoryText(
  payload: unknown,
  sanitizeInput: (payload: unknown) => string | null,
): { ok: boolean; text: string } {
  if (typeof payload === "string") {
    const text = sanitizeInput(payload)?.trim() ?? "";
    return text ? { ok: true, text } : { ok: false, text: "" };
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const rec = payload as Record<string, unknown>;
    const rawText = rec.text;
    const text = typeof rawText === "string" ? (sanitizeInput(rawText)?.trim() ?? "") : "";
    const imageCount = Array.isArray(rec.images) ? rec.images.length : 0;
    const lines: string[] = [];
    if (text) {
      lines.push(text);
    }
    const alreadyReferencesAttachments = text.includes("/api/attachments/");
    if (imageCount > 0 && (!text || !alreadyReferencesAttachments)) {
      lines.push(`Images: ${imageCount}`);
    }
    const joined = lines.join("\n").trim();
    return joined ? { ok: true, text: joined } : { ok: false, text: "" };
  }

  return { ok: false, text: "" };
}

