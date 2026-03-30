export type MarkdownFilePreviewLink = {
  path: string;
  line: number | null;
};

const FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs",
  "rb", "php", "swift", "kt", "scala", "lua", "zig",
  "json", "yaml", "yml", "toml", "ini", "cfg", "env",
  "md", "mdx", "txt", "rst", "adoc",
  "html", "htm", "css", "scss", "less", "sass",
  "vue", "svelte", "astro",
  "xml", "svg", "sql", "graphql", "gql", "proto",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "dockerfile", "makefile",
  "lock", "log", "csv", "tsv",
  "conf", "config", "rc",
]);

function hasFileExtension(basename: string): boolean {
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return false;
  const ext = basename.slice(dotIndex + 1).toLowerCase();
  return FILE_EXTENSIONS.has(ext);
}

function parseFilePreviewFragment(fragment: string): number | null {
  const trimmed = String(fragment ?? "").trim();
  const match = /^L(\d+)$/i.exec(trimmed);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}

function decodeUriPart(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function applyFilePreviewAttrs(
  target: {
    attrSet: (name: string, value: string) => void;
  },
  preview: MarkdownFilePreviewLink,
): void {
  target.attrSet("data-md-link-kind", "file-preview");
  target.attrSet("data-md-file-path", preview.path);
  if (preview.line != null) {
    target.attrSet("data-md-file-line", String(preview.line));
  }
}

export function parseMarkdownFilePreviewHref(href: string): MarkdownFilePreviewLink | null {
  const raw = String(href ?? "").trim();
  if (!raw) return null;
  if (/^(?:https?:|mailto:|javascript:|data:)/i.test(raw)) return null;
  if (raw.startsWith("#")) return null;

  const hashIndex = raw.indexOf("#");
  const rawPath = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const rawFragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";
  const pathPart = decodeUriPart(rawPath).trim();
  const line = parseFilePreviewFragment(rawFragment);
  if (!pathPart || pathPart.endsWith("/")) return null;
  if (pathPart.startsWith("/api/")) return null;

  if (/[(){}[\];,=!<>|&~^?@$]/.test(pathPart)) return null;

  const normalized = pathPart.replace(/\\/g, "/");
  const basename = normalized.split("/").filter(Boolean).pop() ?? normalized;
  const hasExt = hasFileExtension(basename);
  const hasPath = normalized.includes("/");
  if (!hasExt && !(line !== null && hasPath)) return null;

  return { path: pathPart, line };
}
