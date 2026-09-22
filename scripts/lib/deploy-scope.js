/**
 * Change-scope classification for change-scoped (zero-downtime) deploys.
 *
 * A file is "client-scoped" when changing it cannot affect the running
 * backend processes (ads-web / ads-tg): the web server streams dist/client
 * assets from disk on every request, so client-only changes take effect by
 * swapping the `current` release symlink without a service restart.
 */

const CLIENT_SCOPED_PREFIXES = ["client/", "docs/"];

function normalizeFilePath(file) {
  return String(file ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
}

export function isClientScopedFile(file) {
  const normalized = normalizeFilePath(file);
  if (!normalized) return false;
  if (CLIENT_SCOPED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  return normalized.toLowerCase().endsWith(".md");
}

/**
 * Classify a list of changed files (repo-relative paths).
 * Returns "client-only" only when the list is non-empty and every file is
 * client-scoped; anything else — including an empty or missing list, where no
 * safe baseline exists — conservatively returns "full".
 *
 * @param {unknown} files
 * @returns {"client-only" | "full"}
 */
export function classifyChangedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return "full";
  return files.every((file) => isClientScopedFile(file)) ? "client-only" : "full";
}
