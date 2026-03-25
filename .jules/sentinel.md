## 2024-03-25 - Path traversal via partial directory match
**Vulnerability:** Path traversal possible by matching partial directory names (e.g., matching /dist-secrets against /dist) when using string.startsWith() for path validation.
**Learning:** Using startsWith on raw strings without appending a path separator allows access to sibling directories that share the same prefix.
**Prevention:** Always append a path separator to the base directory before using startsWith, and explicitly allow exact base directory matches.
