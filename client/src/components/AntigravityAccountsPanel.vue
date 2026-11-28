<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type { ApiClient } from "../api/client";
import type {
  AgyAccountView,
  AgyAuthMethod,
  AgyLoginStartView,
  RuntimeAgentDescriptor,
  RuntimesSnapshot,
} from "../api/types";
import { clearPendingAgyLoginView, markPendingAgyLoginView } from "../lib/agyPendingLogin";
import { copyTextToClipboard } from "../lib/clipboard";
import SettingsSheet from "./SettingsSheet.vue";

const props = defineProps<{ api: ApiClient }>();
const emit = defineEmits<{ (e: "changed"): void }>();

const AUTH_METHOD_LABELS: Record<AgyAuthMethod, string> = {
  "oauth-personal": "Google OAuth (Personal)",
  "oauth-business": "Gemini Enterprise (GCP)",
  "gemini-api-key": "Gemini API Key",
  "agent-platform": "Agent Platform",
};

const runtimes = ref<RuntimeAgentDescriptor[]>([]);
const accounts = ref<AgyAccountView[]>([]);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const copiedAccountId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const accountDialog = ref(false);
const accountEditor = ref<HTMLFormElement | null>(null);
const deleteTarget = ref<AgyAccountView | null>(null);

const accountForm = reactive<{
  authMethod: AgyAuthMethod;
  apiKey: string;
  gcpProject: string;
  gcpLocation: string;
}>({
  authMethod: "oauth-personal",
  apiKey: "",
  gcpProject: "",
  gcpLocation: "",
});

const activeLogins = ref<Record<string, { authorizationUrl: string; code: string }>>({});

const isStandalonePwa =
  (typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches) ||
  (typeof navigator !== "undefined" &&
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

const isIosDevice =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

const canShare =
  typeof navigator !== "undefined" && typeof navigator.share === "function";

const canReadClipboard =
  typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

const needsApiKey = computed(
  () => accountForm.authMethod === "gemini-api-key" || accountForm.authMethod === "agent-platform",
);
const needsGcp = computed(
  () => accountForm.authMethod === "oauth-business" || accountForm.authMethod === "agent-platform",
);

const readyAgyCount = computed(
  () => runtimes.value.filter((runtime) => (runtime.id === "agy" || runtime.id.startsWith("agy:")) && runtime.ready).length,
);

/** Collapse all Antigravity account routes (`agy`, `agy:*`) into a single Detected Runtime entry. */
const detectedRuntimes = computed<RuntimeAgentDescriptor[]>(() => {
  const nonAgy: RuntimeAgentDescriptor[] = [];
  const agyEntries: RuntimeAgentDescriptor[] = [];
  for (const runtime of runtimes.value) {
    if (runtime.id === "agy" || runtime.id.startsWith("agy:")) {
      agyEntries.push(runtime);
    } else {
      nonAgy.push(runtime);
    }
  }
  if (agyEntries.length === 0) {
    return nonAgy;
  }
  const defaultEntry = agyEntries.find((entry) => entry.id === "agy") ?? agyEntries[0];
  const readyEntries = agyEntries.filter((entry) => entry.ready);
  if (readyEntries.length === 0) {
    return [
      ...nonAgy,
      {
        ...defaultEntry,
        id: "agy",
        name: "Antigravity",
      },
    ];
  }
  if (readyEntries.length === 1 && readyEntries[0].id === "agy") {
    return [...nonAgy, readyEntries[0]];
  }
  const version = readyEntries.find((entry) => entry.version)?.version ?? defaultEntry.version ?? null;
  if (readyEntries.length === 1) {
    const single = readyEntries[0];
    return [
      ...nonAgy,
      {
        ...single,
        id: "agy",
        name: "Antigravity",
        version,
      },
    ];
  }
  return [
    ...nonAgy,
    {
      id: "agy",
      name: "Antigravity",
      kind: "agy",
      ready: true,
      version,
      accountEmail: null,
      tier: null,
      error: null,
    },
  ];
});

function accountDisplayName(account: AgyAccountView): string {
  const email = account.accountEmail?.trim();
  if (account.ready && email) return email;
  const project = account.gcpProject?.trim();
  if (project) return project;
  return AUTH_METHOD_LABELS[account.authMethod] || "Antigravity account";
}

function accountSubtitle(account: AgyAccountView): string {
  const methodLabel = AUTH_METHOD_LABELS[account.authMethod] || account.authMethod;
  if ((account.ready && account.accountEmail?.trim()) || account.gcpProject?.trim()) {
    return `${methodLabel} · ${account.agentId}`;
  }
  return account.agentId;
}

function syncPendingLogins(list: AgyAccountView[]): void {
  const next: Record<string, { authorizationUrl: string; code: string }> = {};
  let hasAnyPending = false;
  for (const account of list) {
    const pendingUrl = account.loginPending ? account.authorizationUrl?.trim() : "";
    if (pendingUrl) {
      hasAnyPending = true;
      next[account.id] = {
        authorizationUrl: pendingUrl,
        code: activeLogins.value[account.id]?.code ?? "",
      };
    }
  }
  activeLogins.value = next;
  if (!hasAnyPending) {
    clearPendingAgyLoginView();
  }
}

async function load(): Promise<void> {
  const [snapshot, accountList] = await Promise.all([
    props.api.get<RuntimesSnapshot>("/api/runtimes"),
    props.api.get<AgyAccountView[]>("/api/runtimes/agy/accounts"),
  ]);
  runtimes.value = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
  accounts.value = Array.isArray(accountList) ? accountList : [];
  syncPendingLogins(accounts.value);
}

async function perform(work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await work();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Operation failed.";
  } finally {
    busy.value = false;
  }
}

function formatRuntimeDetail(runtime: RuntimeAgentDescriptor): string {
  if (!runtime.ready) {
    return runtime.error || "Unavailable";
  }
  const summary =
    runtime.id === "agy" && !runtime.accountEmail?.trim() && readyAgyCount.value > 1
      ? `${readyAgyCount.value} accounts ready`
      : runtime.accountEmail?.trim() || "";
  const parts = [
    summary,
    runtime.id,
    runtime.version ? `v${runtime.version}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function statusLabel(account: AgyAccountView): string {
  if (account.ready) {
    const count = account.modelCount;
    return count > 0 ? `Ready · ${count} model${count === 1 ? "" : "s"}` : "Ready";
  }
  if (account.status === "authentication_required") return "Sign in required";
  if (account.status === "binary_not_found") return "CLI not found";
  return "Unavailable";
}

function openCreateAccount(): void {
  Object.assign(accountForm, {
    authMethod: "oauth-personal" as AgyAuthMethod,
    apiKey: "",
    gcpProject: "",
    gcpLocation: "",
  });
  error.value = "";
  accountDialog.value = true;
}

function closeCreateAccount(): void {
  accountDialog.value = false;
  accountForm.apiKey = "";
}

async function saveAccount(): Promise<void> {
  if (accountEditor.value && !accountEditor.value.reportValidity()) return;
  await perform(async () => {
    const payload: Record<string, unknown> = {
      authMethod: accountForm.authMethod,
    };
    if (needsApiKey.value && accountForm.apiKey.trim()) {
      payload.apiKey = accountForm.apiKey.trim();
    }
    if (needsGcp.value) {
      if (accountForm.gcpProject.trim()) payload.gcpProject = accountForm.gcpProject.trim();
      if (accountForm.gcpLocation.trim()) payload.gcpLocation = accountForm.gcpLocation.trim();
    }
    const created = await props.api.post<AgyAccountView>("/api/runtimes/agy/accounts", payload);
    closeCreateAccount();
    await load();
    emit("changed");
    const name = accountDisplayName(created);
    notice.value = created.ready
      ? `Account "${name}" is ready.`
      : `Account "${name}" added. Click Sign in to authenticate.`;
  });
}

async function refreshAllRuntimes(): Promise<void> {
  await perform(async () => {
    await props.api.post<RuntimesSnapshot>("/api/runtimes/refresh", {});
    await load();
    emit("changed");
    notice.value = "Runtimes re-probed.";
  });
}

async function refreshAccount(account: AgyAccountView): Promise<void> {
  await perform(async () => {
    await props.api.post<AgyAccountView>(
      `/api/runtimes/agy/accounts/${encodeURIComponent(account.id)}/refresh`,
      {},
    );
    await load();
    emit("changed");
    notice.value = `Refreshed "${accountDisplayName(account)}".`;
  });
}

async function startLogin(account: AgyAccountView): Promise<void> {
  await perform(async () => {
    const started = await props.api.post<AgyLoginStartView>(
      `/api/runtimes/agy/accounts/${encodeURIComponent(account.id)}/login/start`,
      {},
    );
    activeLogins.value = {
      ...activeLogins.value,
      [account.id]: {
        authorizationUrl: started.authorizationUrl,
        code: "",
      },
    };
    markPendingAgyLoginView(account.id);
    notice.value = `Open the Google sign-in link for "${accountDisplayName(account)}", then paste the authorization code below.`;
  });
}

function openSignInLink(event: MouseEvent, url: string): void {
  if (!url || (isStandalonePwa && isIosDevice)) {
    return;
  }
  // On desktop (including desktop PWA), prefer a dedicated popup window so sign-in
  // sits alongside the app rather than covering or navigating away from it.
  if (typeof window.open === "function") {
    const popup = window.open(url, "ads-agy-oauth", "popup=yes,width=540,height=720,noopener,noreferrer");
    if (popup) {
      event.preventDefault();
      popup.focus?.();
    }
  }
}

async function copySignInLink(accountId: string): Promise<void> {
  const url = activeLogins.value[accountId]?.authorizationUrl?.trim();
  if (!url) return;
  const ok = await copyTextToClipboard(url);
  if (!ok) {
    error.value = "Unable to copy sign-in link.";
    return;
  }
  copiedAccountId.value = accountId;
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedAccountId.value = null;
    copiedTimer = null;
  }, 2000);
  notice.value = "Sign-in link copied. Open it in Safari or another browser, then paste the code below.";
}

async function shareSignInLink(account: AgyAccountView): Promise<void> {
  const url = activeLogins.value[account.id]?.authorizationUrl?.trim();
  if (!url || !canShare) return;
  try {
    await navigator.share({
      title: "Antigravity Google Sign-In",
      url,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    error.value = "Unable to share sign-in link.";
  }
}

async function pasteLoginCode(accountId: string): Promise<void> {
  const pending = activeLogins.value[accountId];
  if (!pending) return;
  error.value = "";
  try {
    const text = (await navigator.clipboard?.readText?.()) ?? "";
    const trimmed = text.trim();
    if (!trimmed) {
      error.value = "Clipboard is empty. Copy the authorization code or callback URL first.";
      return;
    }
    pending.code = trimmed;
  } catch {
    error.value = "Clipboard read permission was denied. Paste manually into the field.";
  }
}

async function completeLogin(account: AgyAccountView): Promise<void> {
  const pending = activeLogins.value[account.id];
  const code = pending?.code.trim() ?? "";
  if (!code) {
    error.value = "Paste the authorization code or callback URL first.";
    return;
  }
  await perform(async () => {
    try {
      await props.api.post<AgyAccountView>(
        `/api/runtimes/agy/accounts/${encodeURIComponent(account.id)}/login/complete`,
        { code },
      );
    } catch (err) {
      await load().catch(() => {});
      throw err;
    }
    const next = { ...activeLogins.value };
    delete next[account.id];
    activeLogins.value = next;
    if (Object.keys(next).length === 0) {
      clearPendingAgyLoginView();
    }
    await load();
    emit("changed");
    const updated = accounts.value.find((item) => item.id === account.id) ?? account;
    notice.value = `Signed in to "${accountDisplayName(updated)}".`;
  });
}

async function cancelLogin(account: AgyAccountView): Promise<void> {
  await perform(async () => {
    await props.api.post(
      `/api/runtimes/agy/accounts/${encodeURIComponent(account.id)}/login/cancel`,
      {},
    );
    const next = { ...activeLogins.value };
    delete next[account.id];
    activeLogins.value = next;
    if (Object.keys(next).length === 0) {
      clearPendingAgyLoginView();
    }
    notice.value = `Cancelled sign-in for "${accountDisplayName(account)}".`;
  });
}

async function logoutAccount(account: AgyAccountView): Promise<void> {
  await perform(async () => {
    await props.api.post<AgyAccountView>(
      `/api/runtimes/agy/accounts/${encodeURIComponent(account.id)}/logout`,
      {},
    );
    await load();
    emit("changed");
    notice.value = `Signed out "${accountDisplayName(account)}".`;
  });
}

async function confirmDeleteAccount(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  await perform(async () => {
    await props.api.delete(`/api/runtimes/agy/accounts/${encodeURIComponent(target.id)}`);
    deleteTarget.value = null;
    await load();
    emit("changed");
    notice.value = `Deleted "${accountDisplayName(target)}".`;
  });
}

onMounted(() => perform(load));
onBeforeUnmount(() => {
  accountForm.apiKey = "";
  if (copiedTimer !== null) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
});
</script>

<template>
  <div data-testid="settings-runtimes-panel">
    <p class="settingsNote introduction">
      Available agent runtimes are auto-probed at startup. Native uses Settings → Providers; Codex and Antigravity run over ACP with automatic model discovery and persistent credentials.
    </p>
    <p v-if="error && !accountDialog && !deleteTarget" class="settingsFeedback" role="alert">{{ error }}</p>
    <p v-if="notice" class="settingsFeedback" role="status">{{ notice }}</p>

    <article class="settingsBlock" data-testid="detected-runtimes-block">
      <h2 class="settingsBlockTitle">Detected runtimes</h2>
      <div class="settingsList">
        <div
          v-for="runtime in detectedRuntimes"
          :key="runtime.id"
          class="settingsRow"
          :data-testid="`runtime-row-${runtime.id}`"
        >
          <span class="settingsRowContent">
            <span>
              {{ runtime.name }}
              <small
                v-if="runtime.ready && runtime.tier"
                class="tierBadge"
                :data-testid="`runtime-tier-${runtime.id}`"
              >{{ runtime.tier }}</small>
            </span>
            <small class="settingsDetail">
              {{ formatRuntimeDetail(runtime) }}
            </small>
          </span>
          <span class="runtimeBadge" :class="{ ready: runtime.ready }">
            {{ runtime.ready ? "Ready" : "Unavailable" }}
          </span>
        </div>
        <button
          type="button"
          class="settingsRow tinted"
          data-testid="runtimes-refresh-all"
          :disabled="busy"
          @click="refreshAllRuntimes"
        >
          Refresh all runtimes
        </button>
      </div>
    </article>

    <article class="settingsBlock" data-testid="agy-accounts-block">
      <h2 class="settingsBlockTitle">Antigravity accounts</h2>
      <div class="settingsList">
        <div
          v-for="account in accounts"
          :key="account.id"
          class="agyAccountCard"
          :data-testid="`agy-account-row-${account.id}`"
        >
          <div class="settingsRow agyAccountHeader">
            <span class="settingsRowContent">
              <span>
                <span
                  v-if="account.ready && account.accountEmail"
                  class="agyAccountEmail"
                  :data-testid="`agy-account-email-${account.id}`"
                >{{ account.accountEmail }}</span>
                <span v-else>{{ accountDisplayName(account) }}</span>
                <small v-if="account.isDefault" class="accountTag">Host default</small>
                <small
                  v-if="account.ready && account.tier"
                  class="tierBadge"
                  :data-testid="`agy-account-tier-${account.id}`"
                >{{ account.tier }}</small>
              </span>
              <small class="settingsDetail">
                {{ accountSubtitle(account) }}
              </small>
              <small v-if="account.error && !account.ready" class="settingsDetail">{{ account.error }}</small>
            </span>
            <span class="runtimeBadge" :class="{ ready: account.ready }">{{ statusLabel(account) }}</span>
          </div>

          <div class="agyAccountActions">
            <button
              v-if="account.authMethod === 'oauth-personal' || account.authMethod === 'oauth-business'"
              type="button"
              class="agyActionBtn"
              :class="{ primary: !account.ready }"
              :data-testid="`agy-login-start-${account.id}`"
              :disabled="busy || account.status === 'binary_not_found'"
              @click="startLogin(account)"
            >
              {{ account.ready ? "Re-authenticate" : "Sign in" }}
            </button>
            <button
              v-if="!account.isDefault && account.ready && (account.authMethod === 'oauth-personal' || account.authMethod === 'oauth-business')"
              type="button"
              class="agyActionBtn"
              :data-testid="`agy-logout-${account.id}`"
              :disabled="busy"
              @click="logoutAccount(account)"
            >
              Sign out
            </button>
            <button
              type="button"
              class="agyActionBtn"
              :data-testid="`agy-refresh-${account.id}`"
              :disabled="busy"
              @click="refreshAccount(account)"
            >
              Refresh models
            </button>
            <button
              v-if="!account.isDefault"
              type="button"
              class="agyActionBtn destructive"
              :data-testid="`agy-delete-${account.id}`"
              :disabled="busy"
              @click="deleteTarget = account"
            >
              Delete
            </button>
          </div>

          <div
            v-if="activeLogins[account.id]"
            class="agyLoginBox"
            :data-testid="`agy-login-flow-${account.id}`"
          >
            <p class="settingsNote agyLoginHint">
              <template v-if="isStandalonePwa">
                1. Open Google sign-in (opens an in-app sheet — copy the code, then tap Done to return), or use Copy link / Share to sign in from Safari or another browser without covering this app. 2. Paste the authorization code or callback URL below.
              </template>
              <template v-else>
                1. Open Google sign-in and approve access. 2. Copy the authorization code (or full callback URL) and paste it below.
              </template>
            </p>
            <div class="agyLoginLinkRow">
              <a
                :href="activeLogins[account.id].authorizationUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="agyOAuthLink"
                :data-testid="`agy-login-link-${account.id}`"
                @click="openSignInLink($event, activeLogins[account.id].authorizationUrl)"
              >
                Open Google Sign-In ↗
              </a>
              <button
                type="button"
                class="agyActionBtn agyCompactBtn"
                :data-testid="`agy-login-copy-${account.id}`"
                :disabled="busy"
                @click="copySignInLink(account.id)"
              >
                {{ copiedAccountId === account.id ? "Copied" : "Copy link" }}
              </button>
              <button
                v-if="canShare"
                type="button"
                class="agyActionBtn agyCompactBtn"
                :data-testid="`agy-login-share-${account.id}`"
                :disabled="busy"
                @click="shareSignInLink(account)"
              >
                Share…
              </button>
            </div>
            <label class="agyCodeField">
              <span class="agyCodeLabel">Authorization code or callback URL</span>
              <span class="agyCodeInputRow">
                <input
                  v-model="activeLogins[account.id].code"
                  type="text"
                  class="agyCodeInput"
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck="false"
                  :data-testid="`agy-login-code-${account.id}`"
                  placeholder="Paste code or callback URL"
                />
                <button
                  v-if="canReadClipboard"
                  type="button"
                  class="agyActionBtn agyCompactBtn"
                  :data-testid="`agy-login-paste-${account.id}`"
                  :disabled="busy"
                  @click="pasteLoginCode(account.id)"
                >
                  Paste
                </button>
              </span>
            </label>
            <div class="agyAccountActions agyLoginActions">
              <button
                type="button"
                class="agyActionBtn primary"
                :data-testid="`agy-login-complete-${account.id}`"
                :disabled="busy"
                @click="completeLogin(account)"
              >
                Complete sign-in
              </button>
              <button
                type="button"
                class="agyActionBtn"
                :data-testid="`agy-login-cancel-${account.id}`"
                :disabled="busy"
                @click="cancelLogin(account)"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          class="settingsRow tinted"
          data-testid="agy-account-add"
          :disabled="busy"
          @click="openCreateAccount"
        >
          <span aria-hidden="true">＋</span>Add Antigravity account
        </button>
      </div>
      <p class="settingsNote">
        Each added account persists its own isolated GEMINI_HOME credentials on the server. Sign in once and switch directly between accounts in chat without re-logging in (re-authentication is only needed if credentials expire or you sign out).
      </p>
    </article>

    <SettingsSheet
      v-if="accountDialog"
      title="Add Antigravity account"
      action-label="Add"
      action-test-id="agy-account-save"
      test-id="agy-account-dialog"
      :busy="busy"
      @close="closeCreateAccount"
      @submit="saveAccount"
    >
      <form ref="accountEditor" data-testid="agy-account-form" @submit.prevent="saveAccount">
        <p v-if="error" class="settingsFeedback" role="alert">{{ error }}</p>
        <fieldset :disabled="busy">
          <div class="settingsBlock settingsList">
            <label class="settingsField">
              <span>Authentication method</span>
              <select v-model="accountForm.authMethod" data-testid="agy-account-auth-method">
                <option value="oauth-personal">Google OAuth (Personal)</option>
                <option value="oauth-business">Gemini Enterprise (GCP OAuth)</option>
                <option value="gemini-api-key">Gemini API Key</option>
                <option value="agent-platform">Agent Platform</option>
              </select>
            </label>
            <label v-if="needsApiKey" class="settingsField">
              <span>API Key</span>
              <input
                v-model="accountForm.apiKey"
                type="password"
                autocomplete="new-password"
                autocapitalize="none"
                spellcheck="false"
                :required="accountForm.authMethod === 'gemini-api-key'"
                data-testid="agy-account-api-key"
                placeholder="Enter Gemini API key"
              />
            </label>
            <label v-if="needsGcp" class="settingsField">
              <span>GCP Project</span>
              <input
                v-model="accountForm.gcpProject"
                type="text"
                autocapitalize="none"
                spellcheck="false"
                :required="accountForm.authMethod === 'oauth-business'"
                data-testid="agy-account-gcp-project"
                placeholder="my-gcp-project"
              />
            </label>
            <label v-if="needsGcp" class="settingsField">
              <span>GCP Location</span>
              <input
                v-model="accountForm.gcpLocation"
                type="text"
                autocapitalize="none"
                spellcheck="false"
                :required="accountForm.authMethod === 'oauth-business'"
                data-testid="agy-account-gcp-location"
                placeholder="us-central1"
              />
            </label>
          </div>
          <p class="settingsNote">
            <template v-if="accountForm.authMethod === 'oauth-personal' || accountForm.authMethod === 'oauth-business'">
              After adding, sign in with Google to bind your account email automatically.
            </template>
            <template v-else>
              API keys are encrypted on the server and never written to browser storage or plaintext profile files.
            </template>
          </p>
        </fieldset>
      </form>
    </SettingsSheet>

    <SettingsSheet
      v-if="deleteTarget"
      title="Delete account?"
      action-label="Delete"
      destructive
      :busy="busy"
      test-id="agy-account-delete-confirm"
      @close="deleteTarget = null; error = ''"
      @submit="confirmDeleteAccount"
    >
      <div class="settingsBlock">
        <p>Delete {{ accountDisplayName(deleteTarget) }}?</p>
        <p class="settingsNote">
          This removes the isolated Antigravity profile directory and stored credentials on the server.
        </p>
        <p v-if="error" class="settingsFeedback" role="alert">{{ error }}</p>
      </div>
    </SettingsSheet>
  </div>
</template>

<style scoped>
.runtimeBadge {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 500;
  color: var(--settings-secondary);
}
.runtimeBadge.ready {
  color: #248a3d;
}
.accountTag {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  background: rgba(15, 23, 42, 0.06);
  color: var(--settings-secondary);
}
.tierBadge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(0, 122, 255, 0.12);
  color: var(--settings-tint);
}
.agyAccountEmail {
  color: var(--settings-text);
  font-weight: 500;
}
.agyAccountCard + .agyAccountCard {
  border-top: 0.5px solid var(--settings-separator);
}
.agyAccountHeader {
  padding-bottom: 6px;
}
.agyAccountActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 16px 12px;
}
.agyLoginActions {
  padding: 4px 0 0;
}
.agyActionBtn {
  padding: 6px 12px;
  border: 1px solid var(--settings-separator);
  border-radius: 8px;
  background: transparent;
  color: var(--settings-text);
  font-size: 13px;
  font-weight: 500;
}
.agyActionBtn.primary {
  border-color: var(--settings-tint);
  color: var(--settings-tint);
}
.agyActionBtn.destructive {
  border-color: rgba(255, 59, 48, 0.35);
  color: var(--settings-danger);
}
.agyCompactBtn {
  padding: 5px 10px;
  font-size: 12px;
  background: var(--settings-surface);
}
.agyLoginBox {
  margin: 0 16px 14px;
  padding: 12px;
  border: 1px solid var(--settings-separator);
  border-radius: 10px;
  background: rgba(0, 122, 255, 0.04);
}
.agyLoginHint {
  margin: 0 0 10px;
}
.agyLoginLinkRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.agyOAuthLink {
  display: inline-block;
  margin-right: auto;
  font-size: 14px;
  font-weight: 600;
  color: var(--settings-tint);
  text-decoration: none;
}
.agyOAuthLink:hover {
  text-decoration: underline;
}
.agyCodeField {
  display: block;
  padding: 6px 0 8px;
}
.agyCodeLabel {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--settings-secondary);
}
.agyCodeInputRow {
  display: flex;
  align-items: center;
  gap: 8px;
}
.agyCodeInput {
  flex: 1;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  height: 40px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--settings-separator);
  border-radius: 8px;
  background: var(--settings-surface);
  color: var(--settings-text);
  font-size: 16px;
  line-height: 22px;
}
.agyCodeInput::placeholder {
  color: #8e8e93;
}
.agyCodeInput:focus {
  outline: none;
  border-color: var(--settings-tint);
  box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.14);
}
</style>
