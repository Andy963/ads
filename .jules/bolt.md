## 2024-05-19 - Missing indices in graph traversal queries
**Learning:** Graph traversal queries (`SELECT target FROM edges WHERE source = ?`, `getParentNodes` recursive CTE) were scanning the `edges` table sequentially O(N). Because workflow state relies heavily on this structure, queries get significantly slower as the workflow complexity increases.
**Action:** Always verify that adjacency list-style tables like `edges` have indexes on both foreign keys (`source` and `target`) to allow instantaneous traversal.
