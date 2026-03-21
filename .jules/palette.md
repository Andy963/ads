## 2026-03-21 - Missing ARIA labels on Icon Buttons
**Learning:** Found a pattern of missing `aria-label` attributes on purely icon-based buttons in `TaskBoard.vue`. While these elements had a `title` property for hover tooltips, screen readers might not announce the title property consistently depending on browser and screen reader combinations, limiting accessibility.
**Action:** Always ensure purely icon-based buttons have an explicit `aria-label` alongside the `title` property.
