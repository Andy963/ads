import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { z } from "zod";

import type { VoiceConfig, VoiceSettingsResponse } from "../../shared/voice.js";
import { DEFAULT_CORRECTION_SYSTEM_PROMPT } from "../../shared/voice.js";
import { createUpstreamCredentialStore, type UpstreamCredentialStore, type UpstreamCredentials } from "../state/upstreamCredentialStore.js";
import { createModelProviderStore, type ModelProvider } from "../state/modelProviderStore.js";
import { normalizeUpstreamBaseUrl } from "../utils/upstreamUrl.js";
import type { NativeModelConfig } from "../runtime/modelResolver.js";

const namespace = "voice_settings";
const timeout = z.number().int().min(1000).max(180_000);
const apiKey = z.string().trim().min(1).max(16_384).optional();
const providerName = z.string().trim().min(1).max(128);
const providerId = z.string().trim().max(128).nullable().optional();
class CorruptVoiceSettingsError extends Error {}

export const correctionConfigSchema = z.object({
  enabled: z.boolean(),
  provider: providerName,
  providerId,
  baseUrl: z.string().trim().max(2048),
  model: z.string().trim().max(256),
  systemPrompt: z.string().max(8000).refine((value) => value.trim().length > 0).default(DEFAULT_CORRECTION_SYSTEM_PROMPT),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]),
  timeoutMs: timeout,
}).strict();

export const voiceConfigSchema = z.object({
  enabled: z.boolean(),
  transcription: z.object({
    provider: providerName,
    providerId,
    baseUrl: z.string().trim().min(1).max(2048),
    model: z.string().trim().min(1).max(256),
    language: z.string().trim().max(16).regex(/^$|^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/),
    prompt: z.string().max(4000),
    timeoutMs: timeout,
  }).strict(),
  correction: correctionConfigSchema,
  totalTimeoutMs: timeout,
}).strict();

export const saveVoiceSettingsSchema = z.object({
  config: voiceConfigSchema.omit({ correction: true }),
  apiKey,
}).strict();
export const saveCorrectionSettingsSchema = z.object({ config: correctionConfigSchema, apiKey }).strict();

const recordSchema = z.object({
  config: voiceConfigSchema,
  credentialProfile: z.string().uuid().nullable(),
  correctionCredentialProfile: z.string().uuid().nullable(),
}).strict();
type VoiceRecord = z.infer<typeof recordSchema>;
const legacyRecordSchema = z.object({
  config: voiceConfigSchema.extend({ correction: z.object({
    enabled: z.boolean(), modelConfigId: z.string().min(1).max(128).nullable(), timeoutMs: timeout,
  }).strict() }),
  credentialProfile: z.string().uuid(),
}).strict();

export function normalizeVoiceBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("请输入完整的 HTTP 或 HTTPS 服务地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("服务地址必须使用 HTTP 或 HTTPS，不能包含用户名、密码、查询参数或片段。");
  }
  return normalizeUpstreamBaseUrl(url.toString()).replace(/\/+$/, "");
}

export function defaultVoiceConfig(): VoiceConfig {
  return {
    enabled: true,
    transcription: {
      provider: "groq", providerId: null, baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3",
      language: "zh", prompt: "", timeoutMs: 120_000,
    },
    correction: { enabled: false, provider: "openai", providerId: null, baseUrl: "", model: "", systemPrompt: DEFAULT_CORRECTION_SYSTEM_PROMPT, reasoningEffort: "high", timeoutMs: 15_000 },
    totalTimeoutMs: 135_000,
  };
}

export type ResolvedVoiceSettings = {
  config: VoiceConfig;
  transcription: UpstreamCredentials;
  correction?: NativeModelConfig;
  correctionWarning?: string;
};

export function createVoiceSettingsStore(db: Database, credentials: UpstreamCredentialStore = createUpstreamCredentialStore(db)) {
  const read = db.prepare("SELECT value FROM kv_state WHERE namespace = ? AND key = ?");
  const write = db.prepare(`INSERT INTO kv_state (namespace, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const providers = createModelProviderStore(db);
  function readRecord(owner: string): VoiceRecord | null {
    if (!owner.trim()) throw new Error("An authenticated owner is required.");
    const row = read.get(namespace, owner) as { value: string } | undefined;
    if (!row) return null;
    try {
      const value: unknown = JSON.parse(row.value);
      const legacy = legacyRecordSchema.safeParse(value);
      // Keep ASR settings, but never copy a conversation model's connection or secret.
      const record = legacy.success ? {
        ...legacy.data,
        config: { ...legacy.data.config, correction: { ...defaultVoiceConfig().correction,
          enabled: legacy.data.config.correction.enabled, timeoutMs: legacy.data.config.correction.timeoutMs } },
        correctionCredentialProfile: null,
      } : recordSchema.parse(value);
      record.config.transcription.baseUrl = normalizeVoiceBaseUrl(record.config.transcription.baseUrl);
      if (record.config.correction.baseUrl) record.config.correction.baseUrl = normalizeVoiceBaseUrl(record.config.correction.baseUrl);
      return record;
    } catch { throw new CorruptVoiceSettingsError("已保存的语音配置损坏，请重新填写并保存。"); }
  }
  function providerForStage(providerIdValue?: string | null): ModelProvider | null {
    const id = String(providerIdValue ?? "").trim();
    if (!id) return null;
    const provider = providers.getProvider(id);
    if (!provider) throw new Error("所选服务商不存在，请重新选择。");
    return provider;
  }
  function providerCredentialProfile(provider: ModelProvider): string {
    return String(provider.credentialProfile ?? "").trim() || provider.id;
  }
  function hasKey(owner: string, profile: string | null, target: { provider: string; baseUrl: string; providerId?: string | null }): boolean {
    try {
      const provider = providerForStage(target.providerId);
      if (provider) {
        return Boolean(credentials.getMetadata(owner, providerCredentialProfile(provider))?.hasApiKey);
      }
      const metadata = profile ? credentials.getMetadata(owner, profile) : null;
      return Boolean(metadata?.hasApiKey && metadata.provider === target.provider
        && normalizeVoiceBaseUrl(metadata.baseUrl) === target.baseUrl);
    } catch { return false; }
  }
  function get(owner: string): VoiceSettingsResponse {
    let saved;
    try { saved = readRecord(owner); }
    catch (error) {
      if (!(error instanceof CorruptVoiceSettingsError)) throw error;
      return { config: defaultVoiceConfig(), configured: false, hasApiKey: false, correctionHasApiKey: false, source: "defaults", recoveryRequired: true };
    }
    const config = saved?.config ?? defaultVoiceConfig();
    return {
      config, configured: Boolean(saved?.credentialProfile) || Boolean(config.transcription.providerId),
      hasApiKey: hasKey(owner, saved?.credentialProfile ?? null, config.transcription),
      correctionHasApiKey: hasKey(owner, saved?.correctionCredentialProfile ?? null, config.correction),
      source: saved ? "saved" : "defaults",
    };
  }
  function recordForSave(owner: string, replacementKey?: string): VoiceRecord {
    try {
      return readRecord(owner) ?? { config: defaultVoiceConfig(), credentialProfile: null, correctionCredentialProfile: null };
    } catch (error) {
      if (!(error instanceof CorruptVoiceSettingsError) || !replacementKey) throw error;
      return { config: defaultVoiceConfig(), credentialProfile: null, correctionCredentialProfile: null };
    }
  }
  function saveConnection(owner: string, profile: string | null, target: { provider: string; baseUrl: string }, enabled: boolean, replacementKey?: string): string {
    const matches = hasKey(owner, profile, target);
    if (!replacementKey && !matches && (enabled || profile)) {
      throw new Error("首次配置或更换服务地址时，请填写匹配的新 API 密钥。");
    }
    const id = profile ?? randomUUID();
    if (replacementKey) credentials.save(owner, { ...target, apiKey: replacementKey }, id);
    else if (enabled && !credentials.getCredentials(owner, id)) throw new Error("请重新填写 API 密钥。");
    return id;
  }
  function save(owner: string, input: z.infer<typeof saveVoiceSettingsSchema>): VoiceSettingsResponse {
    const parsed = saveVoiceSettingsSchema.parse(input);
    db.transaction(() => {
      const saved = recordForSave(owner, parsed.apiKey);
      const stage = parsed.config.transcription;
      const provider = providerForStage(stage.providerId);
      if (provider) {
        stage.provider = provider.name;
        stage.baseUrl = provider.baseUrl;
        saved.credentialProfile = null;
      } else {
        stage.baseUrl = normalizeVoiceBaseUrl(stage.baseUrl);
        saved.credentialProfile = saveConnection(owner, saved.credentialProfile, stage, parsed.config.enabled, parsed.apiKey);
      }
      saved.config = { ...parsed.config, transcription: stage, correction: saved.config.correction };
      write.run(namespace, owner, JSON.stringify(saved), Date.now());
    })();
    return get(owner);
  }
  function saveCorrection(owner: string, input: z.infer<typeof saveCorrectionSettingsSchema>): VoiceSettingsResponse {
    const parsed = saveCorrectionSettingsSchema.parse(input);
    const target = parsed.config;
    const provider = providerForStage(target.providerId);
    if (provider) {
      target.provider = provider.name;
      target.baseUrl = provider.baseUrl;
    } else if (target.baseUrl) {
      target.baseUrl = normalizeVoiceBaseUrl(target.baseUrl);
    }
    if ((target.enabled && (!target.model || !target.baseUrl)) || (parsed.apiKey && !target.baseUrl)) {
      throw new Error("请填写纠错服务地址和模型名称。");
    }
    db.transaction(() => {
      const saved = recordForSave(owner, parsed.apiKey);
      if (provider) {
        saved.correctionCredentialProfile = null;
      } else if (target.enabled || parsed.apiKey || saved.correctionCredentialProfile) {
        saved.correctionCredentialProfile = saveConnection(owner, saved.correctionCredentialProfile, target, target.enabled, parsed.apiKey);
      }
      saved.config.correction = target;
      write.run(namespace, owner, JSON.stringify(saved), Date.now());
    })();
    return get(owner);
  }
  function providerConnection(owner: string, provider: ModelProvider): UpstreamCredentials {
    if (!provider.isEnabled) throw new Error("所选服务商已停用。");
    const connection = credentials.getCredentials(owner, providerCredentialProfile(provider));
    if (!connection) throw new Error("请先在服务商配置中为该服务商保存 API 密钥。");
    return { baseUrl: provider.baseUrl, provider: provider.name, apiKey: connection.apiKey };
  }
  function resolve(owner: string): ResolvedVoiceSettings {
    // Pin both stages in one synchronous transaction before any upstream request.
    return db.transaction(() => {
      const saved = readRecord(owner);
      if (!saved) throw new Error("请先在模型配置中设置语音转写。");
      const config = saved.config;
      if (!config.enabled) throw new Error("语音输入已禁用。");
      const stage = config.transcription;
      const provider = providerForStage(stage.providerId);
      let connection: UpstreamCredentials | null;
      if (provider) {
        connection = providerConnection(owner, provider);
      } else {
        if (!saved.credentialProfile) throw new Error("请先在模型配置中设置语音转写。");
        if (!hasKey(owner, saved.credentialProfile, stage)) throw new Error("请配置匹配的转写密钥。");
        connection = credentials.getCredentials(owner, saved.credentialProfile);
        if (!connection) throw new Error("请配置转写密钥。");
      }
      const resolved: ResolvedVoiceSettings = { config, transcription: connection };
      if (config.correction.enabled) {
        try {
          const target = config.correction;
          const correctionProvider = providerForStage(target.providerId);
          let correctionConnection: UpstreamCredentials | null;
          if (correctionProvider) {
            if (!target.model) throw new Error("Missing correction model.");
            correctionConnection = providerConnection(owner, correctionProvider);
          } else {
            if (!target.model || !saved.correctionCredentialProfile || !hasKey(owner, saved.correctionCredentialProfile, target)) throw new Error("Missing correction connection.");
            correctionConnection = credentials.getCredentials(owner, saved.correctionCredentialProfile);
            if (!correctionConnection) throw new Error("Missing correction key.");
          }
          resolved.correction = { ...correctionConnection, model: target.model, options: { reasoningEffort: target.reasoningEffort } };
        } catch { resolved.correctionWarning = "纠错配置不可用，已保留原始转写。请在「文本纠错」中填写独立的服务地址、密钥和模型。"; }
      }
      return resolved;
    })();
  }
  return { get, save, saveCorrection, resolve };
}

export type VoiceSettingsStore = ReturnType<typeof createVoiceSettingsStore>;
