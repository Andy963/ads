## 2024-06-25 - ARIA Labels on Icon-only Buttons
**Learning:** Found that custom buttons acting as icons (e.g. `<button><Delete /></button>`) can easily lack `aria-label` attributes if relying solely on native `title` for tooltip. The tooltip provides visual access but screen readers may rely primarily on ARIA attributes to announce action significance.
**Action:** Ensure all icon-only buttons (`Refresh`, `Delete` actions in Draft panels, etc.) have explicit `aria-label` properties defined, even if `title` is set, to guarantee robust keyboard and screen-reader navigation.
