import { readFile } from "node:fs/promises";

const STYLE_SRC_RE = /<style\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>\s*<\/style>/g;

export async function readSfc(relativeToThisTest: string, baseUrl: string): Promise<string> {
  const sfcUrl = new URL(relativeToThisTest, baseUrl);
  const sfc = await readFile(sfcUrl, "utf8");

  const cssParts: string[] = [];
  for (const match of sfc.matchAll(STYLE_SRC_RE)) {
    const rel = match[1];
    if (!rel) continue;
    const cssUrl = new URL(rel, sfcUrl);
    cssParts.push(await readFile(cssUrl, "utf8"));
  }

  if (cssParts.length === 0) return sfc;
  return `${sfc}\n\n${cssParts.join("\n\n")}`;
}

