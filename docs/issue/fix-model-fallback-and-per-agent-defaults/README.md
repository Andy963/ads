# Issue: Fix aggressive default model fallback and support per-agent default models

## 1. Problem Description (Symptom)

In ADS Web/PWA, when opening a project or reconnecting to an existing Worker chat lane:
1. **Active healthy models are unexpectedly overwritten**: Even when a user is actively using an agent (e.g. Codex with a custom model like `gemini-3.7-flash-high` or `gpt-5.6-sol`), opening or refreshing the Web UI triggers `ensureRuntimeModelId` / `alignRuntimeModelForAgent`. If the active model ID is not strictly in the static `compatibleIds` list (or during async initialization races), the system forcefully resets the session's active model to the global default model (e.g. Claude Opus) and immediately overwrites `localStorage`.
2. **Cascading Agent and Session hijacking**: Because the model is forcibly changed to a model from another provider (Anthropic), the frontend automatically changes `activeAgentId` from `codex` to `claude`. When the turn runs, it switches the backend session, orphanizes the existing Codex thread, and triggers degraded `history_injection` ("注入上下文") warning banners.
3. **Flawed "Single Global Default" model architecture**: Currently, `model_configs` only allows a single `is_default: 1` across all agents/CLIs. Setting a default for Claude removes the default for Codex and Droid, guaranteeing that switching or falling back under Codex will pick either the wrong agent or an arbitrary first model in the list.

## 2. Root Cause Analysis

### 2.1 Aggressive Fallback Overwriting in `client/src/app/tasks.ts`
In `ensureRuntimeModelId` and `alignRuntimeModelForAgent`:
```ts
// client/src/app/tasks.ts:123
let candidate = storedModelId ?? normalizeModelId(rt.modelId.value);
if (candidate !== "auto" && !compatibleIds.has(candidate)) {
  candidate = fallbackModelId || "auto"; // 💥 Overwrites user choice without permission!
}
rt.modelId.value = candidate;
localStorage.setItem(key, candidate);
```
Instead of trusting the session's active selection or preserving unknown/custom models gracefully, it forcibly mutates the active model and persists the corruption.

### 2.2 Model Manager enforces single global default
In `server/state/globalModelConfigStore.ts` and `client/src/components/ModelManager.vue`:
```ts
// server/state/globalModelConfigStore.ts:61
const clearDefaultStmt = db.prepare("UPDATE model_configs SET is_default = 0 WHERE is_default <> 0");
```
Setting any model as default clears all other defaults across all CLIs (Codex, Claude, Droid), making it impossible to define a legitimate default per CLI engine.

## 3. Required Behavior & Proposed Fix

1. **Never override an active/stored session model**:
   - `ensureRuntimeModelId` and `alignRuntimeModelForAgent` must never silently overwrite a healthy active model on page load, reconnect, or model list reload.
   - The default model must **only** be used to initialize the model selection for a brand-new, unconfigured session.
2. **Support Per-Agent (CLI) Default Models**:
   - Each CLI agent (`codex`, `claude`, `droid`) should maintain its own independent default model.
   - `globalModelConfigStore` should allow one default model per agent scope, rather than clearing defaults globally.
   - In `ModelManager.vue`, each CLI group section can display and manage its own default model indicator.
3. **Strict One-Way Agent-to-Model Hierarchy**:
   - Selecting a model must never implicitly hijack or mutate `activeAgentId`.
   - The model dropdown must strictly list only models compatible with the currently active CLI.

## 4. Acceptance Criteria & Verification

- Refreshing or reopening a session with a custom/Codex model retains that exact model and does not reset to Claude or any other default.
- `localStorage` and active runtime state are not mutated during model list fetch.
- Each CLI can have its own independent default model set simultaneously in Model Manager.
- All frontend model selection and persistence tests pass (`npm run test:web`).
