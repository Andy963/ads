## 2024-03-27 - Icon-Only Action Buttons Need ARIA Labels
**Learning:** Screen readers and keyboard navigation struggle to identify the purpose of icon-only primary actions (e.g., in TaskBoard row actions) if only a `title` attribute is present. The `title` acts as a tooltip but isn't always reliably parsed by all assistive technologies.
**Action:** Always include an explicit `aria-label` attribute on icon-only interactive elements alongside `title` to ensure they are fully accessible.
