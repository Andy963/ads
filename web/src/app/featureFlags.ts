function parseBoolFlag(value: string): boolean | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return null;
}

function readQueryFlag(param: string): boolean | null {
  try {
    const qs = new URLSearchParams(window.location.search);
    const raw = qs.get(param);
    if (raw == null) return null;
    return parseBoolFlag(raw);
  } catch {
    return null;
  }
}

function readStorageFlag(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return parseBoolFlag(raw);
  } catch {
    return null;
  }
}

export function isTaskVoiceInputEnabled(): boolean {
  const fromQuery = readQueryFlag("taskVoice");
  if (fromQuery != null) return fromQuery;
  const fromStorage = readStorageFlag("ADS_WEB_TASK_VOICE_INPUT");
  if (fromStorage != null) return fromStorage;
  return false;
}

