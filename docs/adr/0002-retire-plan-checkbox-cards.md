# ADR 0002: Retire Plan Checkbox Cards in Favor of Interleaved Turn Streaming Progress

## Status
Accepted

## Context
In previous ADS releases, a dedicated checkbox Plan Card (`planCard` with `☑`, `◐`, `☐` markers) was maintained in the Web Console. This mechanism was introduced primarily to satisfy the legacy artificial prompt constraint requiring multi-step tasks to output a checkable plan checklist.

In practice, this implementation suffered from several foundational architectural deficiencies:
1. **Fragile Upstream Parsing**: It relied on brittle regex heuristics and provider-specific mapping of `todo_list` structures in `workerPromptHandler.ts`, which exhibited inconsistent behavior across different AI models and providers.
2. **Artificial Choreography vs. Real Progress**: Synthetic checkbox choreography provided low contextual value compared to what the model was actually doing. Users received repetitive checklist snapshots rather than meaningful progress.
3. **Monolithic Bubble Concatenation Breakdown (Issue #141)**: In `chatStreaming.ts`, the client blindly concatenated all assistant deltas emitted across a multi-step turn into a single assistant bubble (`content = current + nextChunk`). When commands intervened, the client failed to delineate phase boundaries, welding explanations emitted before, between, and after command executions into a single bloated, repeating mega-bubble.
4. **Card Ordering Inversion**: The legacy semantic card rank forced all `assistant` messages to the bottom (rank 5) and all `execute` cards to the top (rank 3), destroying the chronological narrative between pre-command intent and post-command results.

## Decision
1. **Completely Retire the Dedicated Plan Checkbox Card**:
   - Remove `planCard` markup, summaries, and styling from `client/src/components/MainChatMessageList.vue`.
   - Decommission backend `publishPlan`, `PlanSnapshot`, and `todo_list` event mapping in `server/web/server/ws/workerPromptHandler.ts`. The backend will no longer emit synthetic `type: "plan"` WebSocket events or persist `plan:*` status entries.
2. **Adopt Interleaved Turn Streaming Architecture**:
   - The agent's real-time step explanations preceding and succeeding command executions are themselves the true, living progress of execution.
   - Establish clean phase boundaries in `client/src/app/chatStreaming.ts`: when a command execution or patch occurs, the preceding assistant stream is sealed (`streaming: false`). Subsequent explanations start as a distinct conversational segment positioned chronologically below the completed actions.
   - Treat reconnect `delta_snapshot` payloads as cumulative turn text. The client consumes the assistant text already rendered in the current turn and restores only the unrendered suffix, so reconnect catch-up cannot duplicate earlier conversational phases.
   - Unify execution-layer semantic card ordering in `client/src/lib/chat_sync.ts` so that Thought/Live status remains pinned at the cognitive layer, while assistant commentary and command executions interleave strictly according to their natural chronological occurrence:
     `Pre-command explanation -> Active command block -> Post-command explanation / next step -> Next command block -> Final delivery summary`.

## Consequences
### Positive
- Completely eliminates the monolithic repeating text bubble bug and the snowball duplication effect.
- Restores natural human-agent collaborative rhythm where commands render directly underneath the explanation that triggered them, and follow-up commentary appears below completed commands.
- Eliminates fragile `todo_list` wire mapping and reduces frontend/backend state complexity.
- Replaces synthetic checkbox updates with rich, contextual, real-time narrative progress.

### Trade-offs & Migration
- Historical `plan:*` entries in existing databases remain harmlessly unrendered or treated as plain legacy text, without causing frontend rendering errors.
- External prompt constraints or agents no longer expect a synthetic checkbox UI.
