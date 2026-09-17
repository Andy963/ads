<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ApiClient } from "../api/client";
import type { AuthMe, AuthStatus } from "../api/types";
import { isTextInputElement } from "../lib/dom";

const emit = defineEmits<{
  (e: "logged-in", me: AuthMe): void;
  (e: "auth-required"): void;
}>();

const api = new ApiClient({ baseUrl: "" });

const loading = ref(true);
const initialized = ref<boolean | null>(null);
const me = ref<AuthMe | null>(null);
const username = ref("");
const password = ref("");
const showPassword = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);
const keyboardOpen = ref(false);
let focusOutTimer: number | null = null;
let refreshing = false;
let refreshRequested = false;
let disposed = false;

const canSubmit = computed(() => Boolean(username.value.trim()) && Boolean(password.value));

function updateKeyboardOpenFromActiveElement(): void {
  keyboardOpen.value = isTextInputElement(document.activeElement);
}

function handleFocusIn(): void {
  updateKeyboardOpenFromActiveElement();
}

function handleFocusOut(): void {
  // Let the browser update `document.activeElement` before we compute state.
  if (focusOutTimer !== null) window.clearTimeout(focusOutTimer);
  focusOutTimer = window.setTimeout(() => {
    focusOutTimer = null;
    updateKeyboardOpenFromActiveElement();
  }, 0);
}

async function refresh(): Promise<void> {
  if (disposed) return;
  if (refreshing) {
    refreshRequested = true;
    return;
  }
  refreshing = true;
  loading.value = true;
  error.value = null;
  try {
    const status = await api.get<AuthStatus>("/api/auth/status");
    if (disposed) return;
    initialized.value = status.initialized;
    if (!status.initialized) {
      me.value = null;
      emit("auth-required");
      return;
    }
    me.value = await api.get<AuthMe>("/api/auth/me");
    if (disposed) return;
    emit("logged-in", me.value);
  } catch (e) {
    me.value = null;
    const status = e instanceof Error ? (e.cause as { status?: number } | undefined)?.status : undefined;
    if (!disposed && (status === 401 || status === 403)) emit("auth-required");
    else error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
    refreshing = false;
    if (refreshRequested) {
      refreshRequested = false;
      void refresh();
    }
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await api.post<{ success: true }>("/api/auth/login", { username: username.value.trim(), password: password.value });
    password.value = "";
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function togglePassword(): void {
  showPassword.value = !showPassword.value;
}

onMounted(() => {
  updateKeyboardOpenFromActiveElement();
  void refresh();
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", refreshWhenVisible);
});

function refreshWhenVisible(): void {
  if (document.visibilityState === "visible") void refresh();
}

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("online", refresh);
  document.removeEventListener("visibilitychange", refreshWhenVisible);
  // Prevent stray timers if the component is torn down while a blur is pending.
  if (focusOutTimer !== null) window.clearTimeout(focusOutTimer);
});
</script>

<template>
  <div class="gate" :class="{ 'keyboard-open': keyboardOpen }" @focusin="handleFocusIn" @focusout="handleFocusOut">
    <div class="card">
      <div class="logo">
        <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M13 10V3L4 14h7v7l9-11h-7z" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <p class="eyebrow">AI Agent Workspace</p>
      <h2 class="title">ADS Web</h2>

      <div v-if="loading" class="skeleton" aria-busy="true">
        <div class="skel skel-field"></div>
        <div class="skel skel-field"></div>
        <div class="skel skel-btn"></div>
      </div>

      <template v-else>
        <p v-if="initialized === false" class="desc">
          Admin is not initialized. Run <code>npm run web:init-admin -- --username &lt;username&gt; --password-stdin</code> on the server.
        </p>

        <template v-else-if="initialized === true">
          <p class="desc">Sign in to continue.</p>

          <form class="form" @submit.prevent="submit">
            <label class="field">
              <span class="field-label">Username</span>
              <input
                v-model="username"
                type="text"
                name="username"
                autocomplete="username"
                autocapitalize="off"
                spellcheck="false"
                placeholder="Username"
                data-testid="login-username"
              />
            </label>
            <label class="field">
              <span class="field-label">Password</span>
              <div class="password-wrap">
                <input
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  name="password"
                  autocomplete="current-password"
                  placeholder="Password"
                  data-testid="login-password"
                />
                <button
                  type="button"
                  class="pw-toggle"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  :aria-pressed="showPassword"
                  @click="togglePassword"
                >
                  <svg v-if="!showPassword" class="pw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                  <svg v-else class="pw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/>
                    <path d="M4 4l16 16"/>
                  </svg>
                </button>
              </div>
            </label>
            <button class="submit-btn" type="submit" :disabled="!canSubmit || busy" data-testid="login-submit">
              <span v-if="busy" class="spinner" aria-hidden="true"></span>
              {{ busy ? "Signing in…" : "Sign in" }}
            </button>
          </form>
        </template>
      </template>

      <p v-if="error" class="error" role="alert">
        <svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 9v4"/>
          <path d="M12 17h.01"/>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        </svg>
        <span>{{ error }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.gate {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: calc(24px + env(safe-area-inset-top, 0px)) 24px calc(24px + env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  color-scheme: light;
  background:
    radial-gradient(720px 360px at 50% 24%, rgba(37, 99, 235, 0.07), transparent 70%),
    var(--app-bg);
  color: var(--text);
}
.card {
  width: min(400px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 32px;
  background: var(--surface);
  box-shadow: var(--shadow-md);
  text-align: center;
}
.logo {
  width: 56px;
  height: 56px;
  margin: 0 auto 20px;
  background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
  border-radius: 14px;
  display: grid;
  place-items: center;
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.25);
}
.logo-icon {
  width: 28px;
  height: 28px;
  color: white;
}
.eyebrow {
  margin: 0 0 4px 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted-2);
}
.title {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 8px 0;
  color: var(--text);
}
.desc {
  color: var(--muted);
  margin: 0 0 18px 0;
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: break-word;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  text-align: left;
}
.field {
  display: block;
}
.field-label {
  display: block;
  margin: 0 0 6px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
input {
  width: 100%;
  padding: 11px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--github-border);
  background: var(--surface);
  color: var(--text);
  font-size: 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
input::placeholder {
  color: var(--muted-2);
}
input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
input:-webkit-autofill,
input:-webkit-autofill:hover,
input:-webkit-autofill:focus {
  -webkit-text-fill-color: var(--text);
  -webkit-box-shadow: 0 0 0 1000px var(--surface) inset;
  caret-color: var(--text);
  transition: background-color 999999s ease-out 0s;
}
.password-wrap {
  position: relative;
}
.password-wrap input {
  padding-right: 40px;
}
.pw-toggle {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted-2);
  cursor: pointer;
}
.pw-toggle:hover {
  background: var(--surface-2);
  color: var(--text);
}
.pw-icon {
  width: 18px;
  height: 18px;
}
.submit-btn {
  width: 100%;
  margin-top: 2px;
  padding: 11px 16px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--accent);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-shadow: 0 1px 2px rgba(37, 99, 235, 0.3);
  transition: background-color 0.15s, transform 0.1s, box-shadow 0.15s;
}
.submit-btn:hover:not(:disabled) {
  background: var(--accent-2);
}
.submit-btn:active:not(:disabled) {
  transform: scale(0.98);
}
.submit-btn:disabled {
  background: #93c5fd;
  cursor: not-allowed;
  box-shadow: none;
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.error {
  margin: 16px 0 0 0;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.07);
  color: var(--danger-2);
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  word-break: break-word;
  animation: error-in 0.2s ease-out;
}
.error-icon {
  width: 16px;
  height: 16px;
  flex: none;
  margin-top: 1px;
}
@keyframes error-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 4px;
}
.skel {
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, var(--surface-2) 25%, #eef2f6 50%, var(--surface-2) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}
.skel-field {
  height: 62px;
}
.skel-btn {
  height: 40px;
}
@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

@media (max-width: 640px), (max-height: 480px) {
  .gate {
    padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px));
  }
  .gate.keyboard-open {
    align-items: flex-start;
  }
  .card {
    padding: 24px 20px;
  }
}
</style>
