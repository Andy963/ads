<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiClient } from "../api/client";
import type { AuthMe, AuthStatus } from "../api/types";

const emit = defineEmits<{ (e: "logged-in", me: AuthMe): void }>();

const api = new ApiClient({ baseUrl: "" });

const loading = ref(true);
const initialized = ref<boolean | null>(null);
const me = ref<AuthMe | null>(null);
const username = ref("");
const password = ref("");
const error = ref<string | null>(null);
const busy = ref(false);

const canSubmit = computed(() => Boolean(username.value.trim()) && Boolean(password.value));

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const status = await api.get<AuthStatus>("/api/auth/status");
    initialized.value = status.initialized;
    if (!status.initialized) {
      me.value = null;
      return;
    }
    try {
      me.value = await api.get<AuthMe>("/api/auth/me");
      emit("logged-in", me.value);
    } catch {
      me.value = null;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
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

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div class="gate">
    <div class="card">
      <div class="logo">
        <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M13 10V3L4 14h7v7l9-11h-7z" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h2 class="title">ADS Web</h2>

      <p v-if="loading" class="desc">Loading…</p>

      <template v-else>
        <p v-if="initialized === false" class="desc">
          Admin is not initialized. Run <code>ads web init-admin --username &lt;username&gt; --password-stdin</code> on the server.
        </p>

        <template v-else-if="initialized === true">
          <p class="desc">Sign in to continue.</p>

          <div class="form">
            <input v-model="username" type="text" autocomplete="username" placeholder="Username" />
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              placeholder="Password"
              @keydown.enter.prevent="submit"
            />
            <button class="submit-btn" :disabled="!canSubmit || busy" @click="submit">
              {{ busy ? "Signing in…" : "Sign in" }}
            </button>
          </div>
        </template>
      </template>

      <p v-if="error" class="error">{{ error }}</p>
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
  background: linear-gradient(135deg, #0b1020 0%, #1e293b 100%);
  color: #e5e7eb;
}
.card {
  width: min(520px, 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 32px;
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(12px);
  text-align: center;
}
.logo {
  width: 64px;
  height: 64px;
  margin: 0 auto 24px;
  background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
  border-radius: 16px;
  display: grid;
  place-items: center;
  box-shadow: 0 8px 24px rgba(37, 99, 235, 0.3);
}
.logo-icon {
  width: 32px;
  height: 32px;
  color: white;
}
.title {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 8px 0;
  color: white;
}
.desc {
  color: rgba(229, 231, 235, 0.75);
  margin: 0 0 18px 0;
  font-size: 14px;
  line-height: 1.6;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
input {
  width: 100%;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.3);
  color: #e5e7eb;
  font-size: 14px;
}
input::placeholder {
  color: rgba(229, 231, 235, 0.4);
}
input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
}
.submit-btn {
  width: 100%;
  padding: 14px 16px;
  border-radius: 10px;
  border: none;
  background: #2563eb;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s, transform 0.1s;
}
.submit-btn:hover:not(:disabled) {
  background: #1d4ed8;
}
.submit-btn:active:not(:disabled) {
  transform: scale(0.98);
}
.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.error {
  margin-top: 16px;
  color: #fecaca;
  font-size: 13px;
  word-break: break-word;
}
code {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 13px;
}

@media (max-width: 640px) {
  .gate {
    align-items: flex-start;
    padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px));
  }
  .card {
    padding: 24px 20px;
  }
}
</style>
