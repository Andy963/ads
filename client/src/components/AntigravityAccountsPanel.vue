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

const accountDialog = ref(false);
const accountEditor = ref<HTMLFormElement | null>(null);
const deleteTarget = ref<AgyAccountView | null>(null);

const accountForm = reactive<{
  label: string;
  authMethod: AgyAuthMethod;
  apiKey: string;
  gcpProject: string;
  gcpLocation: string;
}>({
  label: "",
  authMethod: "oauth-personal",
  apiKey: "",
  gcpProject: "",
  gcpLocation: "",
});

const activeLogins = ref<Record<string, { authorizationUrl: string; code: string }>>({});

const needsApiKey = computed(
  () => accountForm.authMethod === "gemini-api-key" || accountForm.authMethod === "agent-platform",
);
const needsGcp = computed(
  () => accountForm.authMethod === "oauth-business" || accountForm.authMethod === "agent-platform",
);

function syncPendingLogins(list: AgyAccountView[]): void {
  const next: Record<string, { authorizationUrl: string; code: string }> = {};
  for (const account of list) {
    const pendingUrl = account.loginPending ? account.authorizationUrl?.trim() : "";
    if (pendingUrl) {
      next[account.id] = {
        authorizationUrl: pendingUrl,
        code: activeLogins.value[account.id]?.code ?? "",
      };
    }
  }
  activeLogins.value = next;
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
    label: "",
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
      label: accountForm.label.trim(),
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
    notice.value = created.ready
      ? `Account "${created.label}" is ready.`
      : `Account "${created.label}" created. Click Sign in to authenticate.`;
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
    notice.value = `Refreshed "${account.label}".`;
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
    notice.value = `Open the Google sign-in link for "${account.label}", then paste the authorization code below.`;
  });
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
    await load();
    emit("changed");
    notice.value = `Signed in to "${account.label}".`;
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
    notice.value = `Cancelled sign-in for "${account.label}".`;
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
    notice.value = `Signed out "${account.label}".`;
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
    notice.value = `Deleted "${target.label}".`;
  });
}

onMounted(() => perform(load));
onBeforeUnmount(() => {
  accountForm.apiKey = "";
});
</script>

<template>
  <div data-testid="settings-runtimes-panel">
    <p class="settingsNote introduction">
      Available agent runtimes are auto-probed at startup. Switch runtimes directly from the chat model selector, or manage isolated Antigravity accounts below.
    </p>
    <p v-if="error && !accountDialog && !deleteTarget" class="settingsFeedback" role="alert">{{ error }}</p>
    <p v-if="notice" class="settingsFeedback" role="status">{{ notice }}</p>

    <article class="settingsBlock" data-testid="detected-runtimes-block">
      <h2 class="settingsBlockTitle">Detected runtimes</h2>
      <div class="settingsList">
        <div
          v-for="runtime in runtimes"
          :key="runtime.id"
          class="settingsRow"
          :data-testid="`runtime-row-${runtime.id}`"
        >
          <span class="settingsRowContent">
            <span>{{ runtime.name }}</span>
            <small class="settingsDetail">
              {{ runtime.ready ? (runtime.version ? `${runtime.id} · v${runtime.version}` : runtime.id) : (runtime.error || 'Unavailable') }}
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
              <span>{{ account.label }} <small v-if="account.isDefault" class="accountTag">Host default</small></span>
              <small class="settingsDetail">
                {{ AUTH_METHOD_LABELS[account.authMethod] || account.authMethod }} · {{ account.agentId }}
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
              1. Open Google sign-in and approve access. 2. Copy the authorization code (or full callback URL) and paste it below.
            </p>
            <div class="agyLoginLinkRow">
              <a
                :href="activeLogins[account.id].authorizationUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="agyOAuthLink"
                :data-testid="`agy-login-link-${account.id}`"
              >
                Open Google Sign-In ↗
              </a>
            </div>
            <label class="settingsField agyCodeField">
              <span>Authorization code or callback URL</span>
              <input
                v-model="activeLogins[account.id].code"
                type="text"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
                :data-testid="`agy-login-code-${account.id}`"
                placeholder="Paste code or callback URL"
              />
            </label>
            <div class="agyAccountActions">
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
              <span>Account label</span>
              <input
                v-model="accountForm.label"
                required
                maxlength="80"
                data-testid="agy-account-label"
                placeholder="e.g. Work Google, Personal Gemini"
              />
            </label>
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
            API keys are encrypted on the server and never written to browser storage or plaintext profile files.
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
        <p>Delete {{ deleteTarget.label }}?</p>
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
.agyLoginBox {
  margin: 0 16px 14px;
  padding: 10px 12px;
  border: 1px solid var(--settings-separator);
  border-radius: 10px;
  background: rgba(0, 122, 255, 0.04);
}
.agyLoginHint {
  margin: 0 0 8px;
}
.agyLoginLinkRow {
  margin-bottom: 8px;
}
.agyOAuthLink {
  display: inline-block;
  font-size: 14px;
  font-weight: 600;
  color: var(--settings-tint);
  text-decoration: none;
}
.agyOAuthLink:hover {
  text-decoration: underline;
}
.agyCodeField {
  padding: 8px 0;
}
</style>
