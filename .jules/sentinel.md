## 2026-07-21 - [Path Traversal bypass in string validation]
**Vulnerability:** A path traversal bypass was found in `server/web/server/httpServer.ts`.
**Learning:** `path.startsWith(baseDir)` is insufficient if `baseDir` doesn't end with a path separator (`/`). This allows traversal attacks using partial directory matching (e.g. `/dist` matching `/dist-secrets`). In addition, URI encoded dot-dots (`%2e%2e`) can bypass traversal checks if the path is not correctly decoded using `decodeURIComponent` before resolving the path.
**Prevention:** Always append `path.sep` to the `baseDir` for string validation when testing path prefixes, or allow exact `baseDir` matching. Ensure inputs representing file paths are `decodeURIComponent`-ed properly within a `try...catch` block.
