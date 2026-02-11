import fs from "node:fs";
import path from "node:path";

import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../workspace/adsPaths.js";

const SOUL_FILE = "soul.md";

const SOUL_TEMPLATE = `# Soul

## Preferences

`;

export interface Preference {
  key: string;
  value: string;
}

export function resolveSoulPath(workspaceRoot: string): string {
  migrateLegacyWorkspaceAdsIfNeeded(workspaceRoot);
  return resolveWorkspaceStatePath(workspaceRoot, SOUL_FILE);
}

export function readSoul(workspaceRoot: string): string {
  const soulPath = resolveSoulPath(workspaceRoot);
  try {
    return fs.readFileSync(soulPath, "utf8");
  } catch {
    return "";
  }
}

export function writeSoul(workspaceRoot: string, content: string): void {
  const soulPath = resolveSoulPath(workspaceRoot);
  fs.mkdirSync(path.dirname(soulPath), { recursive: true });
  fs.writeFileSync(soulPath, content, "utf8");
}

function parsePreferences(content: string): { prefs: Preference[]; sectionStart: number; sectionEnd: number } {
  const prefHeader = /^## Preferences\s*$/m;
  const match = prefHeader.exec(content);
  if (!match) {
    return { prefs: [], sectionStart: -1, sectionEnd: -1 };
  }

  const sectionStart = match.index + match[0].length;

  const nextSection = /^## /m;
  const rest = content.slice(sectionStart);
  const nextMatch = nextSection.exec(rest.replace(/^\n*/, "").length ? rest.slice(1) : "");

  let sectionEnd: number;
  if (nextMatch) {
    sectionEnd = sectionStart + 1 + nextMatch.index;
  } else {
    sectionEnd = content.length;
  }

  const sectionBody = content.slice(sectionStart, sectionEnd);
  const prefs: Preference[] = [];
  const lineRegex = /^- \*\*(.+?)\*\*:\s*(.+)$/gm;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = lineRegex.exec(sectionBody)) !== null) {
    prefs.push({ key: lineMatch[1], value: lineMatch[2].trim() });
  }

  return { prefs, sectionStart, sectionEnd };
}

function buildPreferencesSection(prefs: Preference[]): string {
  if (prefs.length === 0) return "\n";
  return "\n" + prefs.map((p) => `- **${p.key}**: ${p.value}`).join("\n") + "\n";
}

export function listPreferences(workspaceRoot: string): Preference[] {
  const content = readSoul(workspaceRoot);
  if (!content) return [];
  return parsePreferences(content).prefs;
}

export function setPreference(workspaceRoot: string, key: string, value: string): void {
  let content = readSoul(workspaceRoot);
  if (!content) {
    content = SOUL_TEMPLATE;
  }

  const { prefs, sectionStart, sectionEnd } = parsePreferences(content);

  if (sectionStart === -1) {
    content = content.trimEnd() + "\n\n## Preferences\n";
    const updated = parsePreferences(content);
    const newPrefs = [{ key, value }];
    const newSection = buildPreferencesSection(newPrefs);
    writeSoul(workspaceRoot, content.slice(0, updated.sectionStart) + newSection + content.slice(updated.sectionEnd));
    return;
  }

  const idx = prefs.findIndex((p) => p.key.toLowerCase() === key.toLowerCase());
  if (idx >= 0) {
    prefs[idx] = { key: prefs[idx].key, value };
  } else {
    prefs.push({ key, value });
  }

  const newSection = buildPreferencesSection(prefs);
  writeSoul(workspaceRoot, content.slice(0, sectionStart) + newSection + content.slice(sectionEnd));
}

export function deletePreference(workspaceRoot: string, key: string): boolean {
  const content = readSoul(workspaceRoot);
  if (!content) return false;

  const { prefs, sectionStart, sectionEnd } = parsePreferences(content);
  if (sectionStart === -1) return false;

  const idx = prefs.findIndex((p) => p.key.toLowerCase() === key.toLowerCase());
  if (idx < 0) return false;

  prefs.splice(idx, 1);
  const newSection = buildPreferencesSection(prefs);
  writeSoul(workspaceRoot, content.slice(0, sectionStart) + newSection + content.slice(sectionEnd));
  return true;
}
