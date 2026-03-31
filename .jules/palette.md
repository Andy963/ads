## 2024-05-24 - Ensure `aria-label` for Icon-Only Action Buttons in Dynamic Lists
**Learning:** Tooltip attributes (`title`) on icon-only action buttons inside dynamic lists (like TaskBoard rows) are not reliably announced by all screen readers. Missing `aria-label`s can make the interface entirely inaccessible for keyboard/screen reader users.
**Action:** Always add an explicit `aria-label` alongside the `title` attribute for any icon-only button to ensure semantic clarity and reliable accessibility.
