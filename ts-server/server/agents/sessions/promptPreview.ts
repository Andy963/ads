/**
 * Session previews come from the raw prompt that was sent to the provider, and
 * Older ADS prompts may carry a large preamble (agent instructions, legacy
 * rules, and skill listings). Rendering that verbatim would make every session
 * in the picker look identical, so this module recovers the part the user
 * actually typed.
 */

/** Marker ADS appends right before the real user request in composed prompts. */
const USER_REQUEST_MARKERS = [
  "**用户请求（请直接回应以下内容，上面是背景指令）：**",
  "用户请求（请直接回应以下内容，上面是背景指令）：",
];

/** Wrapper elements injected around prompts; dropped with their contents. */
const WRAPPED_TAGS = [
  "system-reminder",
  "global_rules",
  "skill_system",
  "available_skills",
  "requested_skills",
  "INSTRUCTIONS",
  "user_instructions",
];

const CONTEXT_RESTORE_PREFIX = "[Context restore]";

function stripWrappedTags(input: string): string {
  let output = input;
  for (const tag of WRAPPED_TAGS) {
    const pattern = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    output = output.replace(pattern, " ");
  }
  return output;
}

function takeAfterLastMarker(input: string): string {
  for (const marker of USER_REQUEST_MARKERS) {
    const index = input.lastIndexOf(marker);
    if (index >= 0) {
      return input.slice(index + marker.length);
    }
  }
  return input;
}

function dropContextRestoreBlock(input: string): string {
  if (!input.includes(CONTEXT_RESTORE_PREFIX)) {
    return input;
  }
  // The restore block ends with a `---` separator followed by the live request.
  const separatorIndex = input.lastIndexOf("\n---\n");
  if (separatorIndex >= 0) {
    return input.slice(separatorIndex + 5);
  }
  return input;
}

function collapse(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[#>*\-`]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recover the user-authored portion of a composed prompt. Returns an empty
 * string when nothing recognizable survives, letting callers fall back to
 * another source (provider title, ADS history, file name).
 */
export function extractUserFacingPrompt(rawText: string): string {
  const raw = String(rawText ?? "");
  if (!raw.trim()) {
    return "";
  }
  let text = takeAfterLastMarker(raw);
  text = dropContextRestoreBlock(text);
  text = stripWrappedTags(text);
  return collapse(text);
}

/** Shorten a preview for list rendering without cutting mid-surrogate. */
export function truncatePreview(input: string, maxLength = 120): string {
  const text = String(input ?? "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${Array.from(text).slice(0, maxLength).join("")}…`;
}

/** Build the short title shown as the primary line of a session list row. */
export function buildSessionTitle(candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const cleaned = extractUserFacingPrompt(String(candidate ?? ""));
    if (cleaned) {
      return truncatePreview(cleaned, 60);
    }
  }
  return "";
}
