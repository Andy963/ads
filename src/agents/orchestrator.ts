import type { Input } from "./protocol/types.js";
import type {
  AgentAdapter,
  AgentIdentifier,
  AgentMetadata,
  AgentRunResult,
  AgentSendOptions,
  AgentStatus,
} from "./types.js";
import type { SystemPromptManager } from "../systemPrompt/manager.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";
import { discoverSkills } from "../skills/loader.js";
import { saveSkillDraftFromBlock, type SavedSkillDraft } from "../skills/creator.js";
import { setPreference } from "../memory/soul.js";
import { extractPreferenceDirectives, type PreferenceDirective } from "../memory/preferenceDirectives.js";

interface AgentEntry {
  adapter: AgentAdapter;
  metadata: AgentMetadata;
}

export interface HybridOrchestratorOptions {
  adapters: AgentAdapter[];
  defaultAgentId?: AgentIdentifier;
  initialWorkingDirectory?: string;
  initialModel?: string;
  systemPromptManager?: SystemPromptManager;
}

export interface AgentDescriptor {
  metadata: AgentMetadata;
  status: AgentStatus;
}

export class HybridOrchestrator {
  private readonly adapters = new Map<AgentIdentifier, AgentEntry>();
  private activeAgentId: AgentIdentifier;
  private workingDirectory?: string;
  private model?: string;
  private readonly systemPromptManager?: SystemPromptManager;
  private readonly skillAutoloadEnabled: boolean;
  private readonly skillAutosaveEnabled: boolean;
  private readonly preferenceDirectiveEnabled: boolean;

  constructor(options: HybridOrchestratorOptions) {
    if (!options.adapters.length) {
      throw new Error("HybridOrchestrator requires at least one agent adapter");
    }
    this.systemPromptManager = options.systemPromptManager;
    this.skillAutoloadEnabled = parseEnvBoolean(process.env.ADS_SKILLS_AUTOLOAD, true);
    this.skillAutosaveEnabled = parseEnvBoolean(process.env.ADS_SKILLS_AUTOSAVE, true);
    this.preferenceDirectiveEnabled = parseEnvBoolean(process.env.ADS_PREFERENCE_DIRECTIVES, true);

    for (const adapter of options.adapters) {
      this.registerAdapter(adapter);
    }

    this.workingDirectory = options.initialWorkingDirectory;
    this.model = options.initialModel;
    this.activeAgentId = this.resolveInitialAgent(options.defaultAgentId);

    if (this.workingDirectory) {
      this.broadcastWorkingDirectory(this.workingDirectory);
    }

    if (this.model) {
      this.broadcastModel(this.model);
    }
  }

  registerAdapter(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Agent with id "${adapter.id}" already registered`);
    }
    this.adapters.set(adapter.id, { adapter, metadata: adapter.metadata });
    if (!this.activeAgentId) {
      this.activeAgentId = adapter.id;
    }
    if (this.workingDirectory) {
      adapter.setWorkingDirectory?.(this.workingDirectory);
    }
    if (this.model) {
      adapter.setModel?.(this.model);
    }
  }

  private resolveInitialAgent(preferred?: AgentIdentifier): AgentIdentifier {
    if (preferred && this.adapters.has(preferred)) {
      return preferred;
    }
    const iterator = this.adapters.keys().next();
    if (iterator.done) {
      throw new Error("No agents available");
    }
    return iterator.value;
  }

  getActiveAgentId(): AgentIdentifier {
    return this.activeAgentId;
  }

  hasAgent(agentId: AgentIdentifier): boolean {
    return this.adapters.has(agentId);
  }

  listAgents(): AgentDescriptor[] {
    return Array.from(this.adapters.values()).map(({ adapter, metadata }) => ({
      metadata,
      status: adapter.status(),
    }));
  }

  switchAgent(agentId: AgentIdentifier): void {
    if (!this.adapters.has(agentId)) {
      throw new Error(`Agent "${agentId}" is not registered`);
    }
    this.activeAgentId = agentId;
  }

  private get activeEntry(): AgentEntry {
    const entry = this.adapters.get(this.activeAgentId);
    if (!entry) {
      throw new Error(`Active agent "${this.activeAgentId}" not found`);
    }
    return entry;
  }

  private mergeSystemPrompt(systemText: string, input: Input): Input {
    if (!systemText.trim()) {
      return input;
    }
    const separator = "\n\n---\n\n**用户请求（请直接回应以下内容，上面是背景指令）：**\n\n";
    if (typeof input === "string") {
      return `${systemText}${separator}${input}`;
    }
    if (Array.isArray(input)) {
      return [{ type: "text", text: `${systemText}${separator}` }, ...input];
    }
    return `${systemText}${separator}${String(input ?? "")}`;
  }

  private extractRequestedSkills(input: Input): string[] {
    const chunks: string[] = [];
    if (typeof input === "string") {
      chunks.push(input);
    } else if (Array.isArray(input)) {
      for (const part of input) {
        if (part.type === "text") {
          chunks.push(part.text);
        }
      }
    }
    const text = chunks.join("\n");
    if (!text.includes("$")) {
      return [];
    }
    const names = new Set<string>();
    for (const match of text.matchAll(/\$([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/g)) {
      const name = match[1]?.trim();
      if (name) {
        names.add(name);
      }
    }
    return Array.from(names);
  }

  private inferRequestedSkills(input: Input): string[] {
    if (!this.skillAutoloadEnabled) {
      return [];
    }
    const workspaceRoot = detectWorkspaceFrom(this.workingDirectory ?? process.cwd());
    const skills = discoverSkills(workspaceRoot);
    if (skills.length === 0) {
      return [];
    }

    const text = extractInputText(input);
    const lowered = text.trim().toLowerCase();
    if (!lowered) {
      return [];
    }

    const tokens = tokenize(lowered);
    if (tokens.length === 0) {
      return [];
    }
    const tokenSet = new Set(tokens);

    const scored: Array<{ name: string; score: number }> = [];
    for (const skill of skills) {
      const skillName = skill.name.toLowerCase();
      if (lowered.includes(skillName)) {
        scored.push({ name: skill.name, score: 1_000 });
        continue;
      }
      const nameTokens = tokenize(skillName);
      const descTokens = tokenize(String(skill.description ?? "").toLowerCase());
      let score = 0;
      for (const tok of nameTokens) {
        if (tokenSet.has(tok)) {
          score += 3;
        }
      }
      for (const tok of descTokens) {
        if (tokenSet.has(tok)) {
          score += isNonAsciiToken(tok) ? 2 : 1;
        }
      }
      if (score > 0) {
        scored.push({ name: skill.name, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.filter((entry) => entry.score >= 2 || entry.score >= 1_000).slice(0, 2).map((s) => s.name);
  }

  private persistSkillsFromResponse(raw: string): { cleaned: string; saved: SavedSkillDraft[] } {
    if (!this.skillAutosaveEnabled) {
      return { cleaned: raw, saved: [] };
    }
    const blocks = extractSkillSaveBlocks(raw);
    if (blocks.length === 0) {
      return { cleaned: raw, saved: [] };
    }
    const workspaceRoot = detectWorkspaceFrom(this.workingDirectory ?? process.cwd());
    const saved: SavedSkillDraft[] = [];
    for (const block of blocks) {
      try {
        const result = saveSkillDraftFromBlock({
          workspaceRoot,
          name: block.name,
          description: block.description,
          body: block.body,
        });
        saved.push(result);
      } catch {
        // ignore autosave failures to avoid breaking the user-visible response
      }
    }
    const cleaned = stripSkillSaveBlocks(raw).trim();
    return { cleaned, saved };
  }

  private persistPreferencesFromInput(input: Input): { cleanedInput: Input; saved: PreferenceDirective[] } {
    if (!this.preferenceDirectiveEnabled) {
      return { cleanedInput: input, saved: [] };
    }

    const text = extractInputText(input);
    if (!text.trim()) {
      return { cleanedInput: input, saved: [] };
    }

    const extracted = extractPreferenceDirectives(text);
    if (extracted.directives.length === 0) {
      return { cleanedInput: input, saved: [] };
    }

    const workspaceRoot = detectWorkspaceFrom(this.workingDirectory ?? process.cwd());
    for (const directive of extracted.directives) {
      setPreference(workspaceRoot, directive.key, directive.value);
    }

    const cleanedInput = replaceInputText(input, extracted.cleanedText);
    return { cleanedInput, saved: extracted.directives };
  }

  private applySystemPrompt(agentId: AgentIdentifier, input: Input): Input {
    if (!this.systemPromptManager) {
      return input;
    }
    const requestedSkills = uniqStrings([...this.extractRequestedSkills(input), ...this.inferRequestedSkills(input)]);
    if (requestedSkills.length > 0) {
      this.systemPromptManager.setRequestedSkills(requestedSkills);
    }
    const injection = this.systemPromptManager.maybeInject();
    if (!injection) {
      return input;
    }
    const entry = this.adapters.get(agentId);
    const agentName = entry?.metadata.name ?? agentId;
    const aliasNote =
      `You are ${agentName} (id: ${agentId}), the active ADS agent. ` +
      `If the following instructions mention "Codex", treat them as referring to you.`;
    const decorated = `${aliasNote}\n\n${injection.text}`;
    return this.mergeSystemPrompt(decorated, input);
  }

  private completeTurn(agentId: AgentIdentifier): void {
    if (!this.systemPromptManager) {
      return;
    }
    void agentId;
    this.systemPromptManager.completeTurn();
  }

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return this.activeEntry.adapter.getStreamingConfig();
  }

  status(): AgentStatus & { agentId: AgentIdentifier } {
    const status = this.activeEntry.adapter.status();
    return { ...status, agentId: this.activeAgentId };
  }

  onEvent(handler: Parameters<AgentAdapter["onEvent"]>[0]): () => void {
    return this.activeEntry.adapter.onEvent(handler);
  }

  reset(): void {
    for (const { adapter } of this.adapters.values()) {
      adapter.reset();
    }
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const agentId = this.activeAgentId;
    const entry = this.adapters.get(agentId);
    if (!entry) {
      throw new Error(`Active agent "${agentId}" not found`);
    }
    const preferences = this.persistPreferencesFromInput(input);
    const cleanedInput = preferences.cleanedInput;
    if (preferences.saved.length > 0 && isEmptyInput(cleanedInput)) {
      return {
        response: formatSavedPreferencesSuffix(preferences.saved),
        usage: null,
        agentId,
      };
    }

    const prompt = this.applySystemPrompt(agentId, cleanedInput);
    try {
      const result = await entry.adapter.send(prompt, options);
      const persisted = this.persistSkillsFromResponse(result.response);
      const suffixes: string[] = [];
      if (persisted.saved.length > 0) {
        suffixes.push(`（已自动沉淀 skill: ${persisted.saved.map((s) => s.skillName).join(", ")}）`);
      }
      if (preferences.saved.length > 0) {
        suffixes.push(formatSavedPreferencesSuffix(preferences.saved));
      }
      const suffix = suffixes.length > 0 ? `\n\n${suffixes.join("\n")}` : "";
      return { ...result, response: `${persisted.cleaned}${suffix}`.trim() };
    } finally {
      this.completeTurn(agentId);
    }
  }

  async invokeAgent(agentId: AgentIdentifier, input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const entry = this.adapters.get(agentId);
    if (!entry) {
      throw new Error(`Agent "${agentId}" is not registered`);
    }
    const preferences = this.persistPreferencesFromInput(input);
    const cleanedInput = preferences.cleanedInput;
    if (preferences.saved.length > 0 && isEmptyInput(cleanedInput)) {
      return {
        response: formatSavedPreferencesSuffix(preferences.saved),
        usage: null,
        agentId,
      };
    }

    const prompt = this.applySystemPrompt(agentId, cleanedInput);
    try {
      const result = await entry.adapter.send(prompt, options);
      const persisted = this.persistSkillsFromResponse(result.response);
      const suffixes: string[] = [];
      if (persisted.saved.length > 0) {
        suffixes.push(`（已自动沉淀 skill: ${persisted.saved.map((s) => s.skillName).join(", ")}）`);
      }
      if (preferences.saved.length > 0) {
        suffixes.push(formatSavedPreferencesSuffix(preferences.saved));
      }
      const suffix = suffixes.length > 0 ? `\n\n${suffixes.join("\n")}` : "";
      return { ...result, response: `${persisted.cleaned}${suffix}`.trim() };
    } finally {
      this.completeTurn(agentId);
    }
  }

  setWorkingDirectory(workingDirectory?: string): void {
    this.workingDirectory = workingDirectory;
    const workspaceRoot = detectWorkspaceFrom(workingDirectory ?? process.cwd());
    this.systemPromptManager?.setWorkspaceRoot(workspaceRoot);
    this.broadcastWorkingDirectory(workingDirectory);
  }

  private broadcastWorkingDirectory(workingDirectory?: string): void {
    for (const { adapter } of this.adapters.values()) {
      adapter.setWorkingDirectory?.(workingDirectory);
    }
  }

  setModel(model?: string): void {
    this.model = model;
    this.broadcastModel(model);
  }

  private broadcastModel(model?: string): void {
    for (const { adapter } of this.adapters.values()) {
      adapter.setModel?.(model);
    }
  }

  getThreadId(): string | null {
    return this.activeEntry.adapter.getThreadId?.() ?? null;
  }

  async classifyInput(input: string) {
    const adapter = this.activeEntry.adapter.classifyInput
      ? this.activeEntry.adapter
      : this.adapters.get("codex")?.adapter;

    if (!adapter || !adapter.classifyInput) {
      throw new Error("No agent available to classify input");
    }

    return adapter.classifyInput(input);
  }
}

type SkillSaveBlock = { name: string; description: string | null; body: string };

function parseEnvBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function extractInputText(input: Input): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return String(input ?? "");
  return input
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function tokenize(text: string): string[] {
  const lowered = String(text ?? "").toLowerCase();
  if (!lowered.trim()) {
    return [];
  }

  const tokens = new Set<string>();

  for (const match of lowered.matchAll(/[a-z0-9]{3,}/g)) {
    tokens.add(match[0]);
  }

  const cjkRe = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
  for (const match of lowered.matchAll(cjkRe)) {
    const seq = match[0];
    const sample = seq.length > 32 ? seq.slice(0, 32) : seq;
    if (sample.length >= 2 && sample.length <= 6) {
      tokens.add(sample);
    }
    addCjkNgrams(tokens, sample, 2);
    addCjkNgrams(tokens, sample, 3);
  }

  return Array.from(tokens);
}

function addCjkNgrams(out: Set<string>, seq: string, n: number): void {
  if (seq.length < n) return;
  for (let i = 0; i <= seq.length - n; i += 1) {
    out.add(seq.slice(i, i + n));
  }
}

function uniqStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function isNonAsciiToken(token: string): boolean {
  for (let i = 0; i < token.length; i += 1) {
    if (token.charCodeAt(i) > 0x7f) {
      return true;
    }
  }
  return false;
}

function extractSkillSaveBlocks(text: string): SkillSaveBlock[] {
  const blocks: SkillSaveBlock[] = [];
  const re = /<skill_save\s+name="([^"]+)"(?:\s+description="([^"]*)")?\s*>([\s\S]*?)<\/skill_save>/gi;
  for (const match of text.matchAll(re)) {
    const name = String(match[1] ?? "").trim();
    if (!name) continue;
    const description = match[2] !== undefined ? String(match[2]).trim() : null;
    const body = String(match[3] ?? "").trim();
    blocks.push({ name, description, body });
  }
  return blocks;
}

function stripSkillSaveBlocks(text: string): string {
  return text.replace(/<skill_save\s+name="[^"]+"(?:\s+description="[^"]*")?\s*>[\s\S]*?<\/skill_save>/gi, "");
}

function replaceInputText(input: Input, nextText: string): Input {
  if (typeof input === "string") {
    return nextText;
  }
  if (!Array.isArray(input)) {
    return String(nextText ?? "");
  }

  const trimmed = String(nextText ?? "").trim();
  const out: Input = [];
  let replaced = false;
  for (const part of input) {
    if (part.type === "text") {
      if (replaced) {
        continue;
      }
      replaced = true;
      if (trimmed) {
        out.push({ ...part, text: nextText });
      }
      continue;
    }
    out.push(part);
  }

  if (!replaced && trimmed) {
    out.unshift({ type: "text", text: nextText });
  }

  return out;
}

function isEmptyInput(input: Input): boolean {
  if (typeof input === "string") return input.trim().length === 0;
  if (!Array.isArray(input)) return String(input ?? "").trim().length === 0;
  for (const part of input) {
    if (part.type === "text" && part.text.trim()) {
      return false;
    }
    if (part.type !== "text") {
      return false;
    }
  }
  return true;
}

function formatSavedPreferencesSuffix(saved: PreferenceDirective[]): string {
  const formatted = saved.map((p) => `${p.key}=${p.value}`).join(", ");
  return `（已保存偏好: ${formatted}）`;
}
