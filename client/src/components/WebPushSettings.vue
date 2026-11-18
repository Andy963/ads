<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ApiClient } from "../api/client";
import { t } from "../lib/i18n";

type WebPushConfig = { enabled: boolean; publicKey: string | null };

const props = defineProps<{ api: ApiClient }>();
const config = ref<WebPushConfig | null>(null);
const active = ref(false);
const busy = ref(false);
const error = ref("");
let disposed = false;

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const supported = computed(() => window.isSecureContext
  && (!isIos || isStandalone)
  && "Notification" in window
  && typeof PushManager !== "undefined"
  && "serviceWorker" in navigator);
const permissionDenied = computed(() => "Notification" in window && Notification.permission === "denied");
const unavailableReason = computed(() => {
  if (!window.isSecureContext) return t("webPush.httpsRequired");
  if (isIos && !isStandalone) return t("webPush.iosInstallRequired");
  if (!supported.value) return t("webPush.unsupported");
  if (permissionDenied.value) return t("webPush.permissionDenied");
  if (config.value && !config.value.enabled) return t("webPush.serverDisabled");
  return "";
});

function decodeApplicationServerKey(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}

async function load(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    const response = await props.api.get<WebPushConfig>("/api/web-push/config");
    if (disposed) return;
    config.value = response;
    if (supported.value) {
      const registration = await navigator.serviceWorker.ready;
      if (disposed) return;
      active.value = Boolean(await registration.pushManager.getSubscription());
    }
  } catch {
    if (!disposed) error.value = t("webPush.loadFailed");
  } finally {
    if (!disposed) busy.value = false;
  }
}

async function enable(): Promise<void> {
  if (busy.value || !config.value?.enabled || !config.value.publicKey || !supported.value) return;
  busy.value = true;
  error.value = "";
  try {
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") {
      error.value = permission === "denied" ? t("webPush.permissionDenied") : t("webPush.permissionNotGranted");
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription()
      ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(config.value.publicKey),
      });
    await props.api.post("/api/web-push/subscription", subscription.toJSON());
    active.value = true;
  } catch {
    error.value = t("webPush.enableFailed");
  } finally {
    busy.value = false;
  }
}

async function disable(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await props.api.post("/api/web-push/unsubscribe", { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    active.value = false;
  } catch {
    error.value = t("webPush.disableFailed");
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
onBeforeUnmount(() => { disposed = true; });
</script>

<template>
  <section class="settingsBody settingsScrollArea" data-testid="web-push-settings">
    <header class="destinationHeader"><h1>{{ t("webPush.title") }}</h1></header>
    <p class="settingsNote introduction">{{ t("webPush.description") }}</p>
    <p v-if="busy && !config" class="settingsNote" role="status">{{ t("webPush.loading") }}</p>
    <p v-if="unavailableReason" class="settingsNote" role="status">{{ unavailableReason }}</p>
    <p v-if="error" class="settingsFeedback" role="alert">{{ error }}</p>
    <div class="settingsBlock settingsList">
      <button
        v-if="active"
        type="button"
        class="settingsRow destructive centered"
        data-testid="web-push-disable"
        :disabled="busy"
        @click="disable"
      >{{ t("webPush.disable") }}</button>
      <button
        v-else
        type="button"
        class="settingsRow tinted centered"
        data-testid="web-push-enable"
        :disabled="busy || !config?.enabled || !supported || permissionDenied"
        @click="enable"
      >{{ t("webPush.enable") }}</button>
    </div>
    <p v-if="active" class="settingsNote" role="status">{{ t("webPush.enabled") }}</p>
    <p v-else-if="config?.enabled && !unavailableReason" class="settingsNote">{{ t("webPush.notEnabled") }}</p>
  </section>
</template>
