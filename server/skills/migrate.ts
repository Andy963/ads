import fs from "node:fs";
import path from "node:path";

import yaml from "yaml";

import { resolveAdsStateDir } from "../workspace/adsPaths.js";

const skillsRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(resolveAdsStateDir(), ".agent", "skills");
const metadataPath = path.join(skillsRoot, "metadata.yaml");
const metadata = fs.existsSync(metadataPath) ? yaml.parse(fs.readFileSync(metadataPath, "utf8")) : {};
const overrides = metadata?.skills && typeof metadata.skills === "object" ? metadata.skills : {};
const timestamp = Date.now();

for (const entry of fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot, { withFileTypes: true }) : []) {
  if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
  const skillMd = path.join(skillsRoot, entry.name, "SKILL.md");
  if (!fs.existsSync(skillMd)) continue;
  const content = fs.readFileSync(skillMd, "utf8");
  const parsed = extractFrontmatter(content);
  const body = parsed.body;
  const fm = parsed.frontmatter;
  const override = overrides[entry.name] ?? {};
  const next = {
    name: fm.name ?? entry.name,
    description: fm.description ?? "No description provided.",
    version: fm.version ?? 1,
    provides: override.provides ?? fm.provides ?? [],
    priority: override.priority ?? fm.priority ?? 100,
    platforms: fm.platforms ?? ["linux", "macos", "win32"],
    required_env: fm.required_env ?? [],
    triggers: fm.triggers ?? { keywords: [], intents: [] },
    entrypoints: fm.entrypoints ?? [],
    deprecated: Boolean(override.provides || override.priority),
  };
  fs.copyFileSync(skillMd, `${skillMd}.bak.${timestamp}`);
  fs.writeFileSync(skillMd, `---\n${yaml.stringify(next).trim()}---\n${body.trimStart()}`, "utf8");
  console.log(`migrated ${entry.name}`);
}

function extractFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: content };
  const raw = content.slice(content.indexOf("\n") + 1, end);
  const body = content.slice(end + 4);
  const parsed = yaml.parse(raw);
  return { frontmatter: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}, body };
}
