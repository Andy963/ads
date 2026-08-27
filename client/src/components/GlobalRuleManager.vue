<script setup lang="ts">
import { computed, onMounted, reactive, ref, type Component } from "vue";
import {
  Aim,
  CircleCheck,
  CircleClose,
  Clock,
  Close,
  Delete,
  Document,
  EditPen,
  Plus,
  Refresh,
  View,
  Warning,
} from "@element-plus/icons-vue";

import type { ApiClient } from "../api/client";
import type {
  GlobalRule,
  GlobalRuleAuditEntry,
  GlobalRulesPreview,
  RuleEnforcementResult,
  RuleSeverity,
} from "../api/types";

type RuleForm = {
  id: string;
  title: string;
  body: string;
  category: string;
  severity: RuleSeverity;
  enabled: boolean;
  priority: number;
  agents: string;
  channels: string;
  tools: string;
  commandPatterns: string;
  pathPatterns: string;
};

type TabKey = "rules" | "test" | "preview" | "audit";

const props = withDefaults(
  defineProps<{
    api: ApiClient;
    showHeader?: boolean;
    showAddButton?: boolean;
  }>(),
  {
    showHeader: true,
    showAddButton: true,
  },
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "changed"): void;
}>();

const SEVERITIES: Array<{ value: RuleSeverity; label: string; hint: string }> = [
  { value: "advisory", label: "advisory", hint: "仅注入提示，不参与拦截" },
  { value: "required", label: "required", hint: "必须满足，命中时记录" },
  { value: "approval_required", label: "approval_required", hint: "无明确授权时阻断" },
  { value: "blocked", label: "blocked", hint: "无条件拒绝" },
];

const CATEGORIES = ["instruction", "safety", "execution"];

const TABS: Array<{ key: TabKey; label: string; icon: Component }> = [
  { key: "rules", label: "规则", icon: Document },
  { key: "test", label: "规则测试", icon: Aim },
  { key: "preview", label: "注入预览", icon: View },
  { key: "audit", label: "最近修改", icon: Clock },
];

const AUDIT_ACTION_LABELS: Record<GlobalRuleAuditEntry["action"], string> = {
  create: "创建",
  update: "更新",
  enable: "启用",
  disable: "停用",
  delete: "删除",
};

const DECISION_LABELS: Record<RuleEnforcementResult["decision"], string> = {
  allow: "放行",
  require_approval: "需要授权",
  deny: "拒绝",
};

const MODE_LABELS: Record<RuleEnforcementResult["mode"], string> = {
  observe: "观察",
  enforce: "强制执行",
};

const rules = ref<GlobalRule[]>([]);
const auditEntries = ref<GlobalRuleAuditEntry[]>([]);
const preview = ref<GlobalRulesPreview | null>(null);
const testResult = ref<RuleEnforcementResult | null>(null);

const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const busyRowId = ref<string | null>(null);
const error = ref<string | null>(null);
const statusMessage = ref<string | null>(null);
const editingId = ref<string | null>(null);
const dialogOpen = ref(false);
const pendingDeleteId = ref<string | null>(null);
const activeTab = ref<TabKey>("rules");

const emptyForm = (): RuleForm => ({
  id: "",
  title: "",
  body: "",
  category: "instruction",
  severity: "required",
  enabled: true,
  priority: 100,
  agents: "",
  channels: "",
  tools: "",
  commandPatterns: "",
  pathPatterns: "",
});

const form = reactive<RuleForm>(emptyForm());

const testForm = reactive({
  agent: "codex",
  channel: "web",
  tool: "shell",
  command: "",
  userExplicitlyApproved: false,
});

function assignForm(next: RuleForm): void {
  Object.assign(form, next);
}

function splitLines(raw: string): string[] {
  return String(raw ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function joinLines(list: string[] | undefined): string {
  return (list ?? []).join("\n");
}

const busy = computed(() => saving.value || loading.value || busyRowId.value !== null);
const isEditing = computed(() => Boolean(editingId.value));

const invalidPatterns = computed(() => {
  const bad: string[] = [];
  for (const pattern of [...splitLines(form.commandPatterns), ...splitLines(form.pathPatterns)]) {
    try {
      new RegExp(pattern, "i");
    } catch {
      bad.push(pattern);
    }
  }
  return bad;
});

const canSubmit = computed(() => {
  if (saving.value) return false;
  if (!form.title.trim() || !form.body.trim()) return false;
  return invalidPatterns.value.length === 0;
});

const sortedRules = computed(() =>
  [...rules.value].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.createdAt - b.createdAt;
  }),
);

const enabledCount = computed(() => rules.value.filter((rule) => rule.enabled).length);

const decisionIcon = computed(() => {
  if (!testResult.value) return CircleCheck;
  if (testResult.value.decision === "deny") return CircleClose;
  if (testResult.value.decision === "require_approval") return Warning;
  return CircleCheck;
});

function formatTime(ts: number): string {
  if (!ts) return "-";
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function isEnforceable(rule: GlobalRule): boolean {
  const match = rule.match;
  if (!match) return false;
  return Boolean(
    match.tools?.length || match.commandPatterns?.length || match.pathPatterns?.length,
  );
}

function bodyExcerpt(body: string): string {
  return String(body ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function matchSummary(rule: GlobalRule): string {
  const match = rule.match;
  if (!match) return "";
  const parts: string[] = [];
  if (match.agents?.length) parts.push(`agent: ${match.agents.join("/")}`);
  if (match.channels?.length) parts.push(`channel: ${match.channels.join("/")}`);
  if (match.tools?.length) parts.push(`tool: ${match.tools.join("/")}`);
  if (match.commandPatterns?.length) parts.push(`${match.commandPatterns.length} 条命令匹配`);
  if (match.pathPatterns?.length) parts.push(`${match.pathPatterns.length} 条路径匹配`);
  return parts.join(" · ");
}

async function loadRules(): Promise<void> {
  loading.value = true;
  error.value = null;
  pendingDeleteId.value = null;
  try {
    const [listed, previewed, audited] = await Promise.all([
      props.api.get<{ rules: GlobalRule[] }>("/api/global-rules"),
      props.api.get<GlobalRulesPreview>("/api/global-rules/preview"),
      props.api.get<{ entries: GlobalRuleAuditEntry[] }>("/api/global-rules/audit?limit=20"),
    ]);
    rules.value = listed.rules ?? [];
    preview.value = previewed;
    auditEntries.value = audited.entries ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function closeDialog(): void {
  editingId.value = null;
  dialogOpen.value = false;
  assignForm(emptyForm());
  error.value = null;
}

function startCreate(): void {
  editingId.value = null;
  dialogOpen.value = true;
  pendingDeleteId.value = null;
  const next = emptyForm();
  next.priority = (rules.value.reduce((max, rule) => Math.max(max, rule.priority), 90) ?? 90) + 10;
  assignForm(next);
  error.value = null;
  statusMessage.value = null;
}

function editRule(rule: GlobalRule): void {
  editingId.value = rule.id;
  dialogOpen.value = true;
  pendingDeleteId.value = null;
  assignForm({
    id: rule.id,
    title: rule.title,
    body: rule.body,
    category: rule.category,
    severity: rule.severity,
    enabled: rule.enabled,
    priority: rule.priority,
    agents: joinLines(rule.match?.agents),
    channels: joinLines(rule.match?.channels),
    tools: joinLines(rule.match?.tools),
    commandPatterns: joinLines(rule.match?.commandPatterns),
    pathPatterns: joinLines(rule.match?.pathPatterns),
  });
  error.value = null;
  statusMessage.value = null;
}

function buildPayload(): Record<string, unknown> {
  const match = {
    agents: splitLines(form.agents),
    channels: splitLines(form.channels),
    tools: splitLines(form.tools),
    commandPatterns: splitLines(form.commandPatterns),
    pathPatterns: splitLines(form.pathPatterns),
  };
  const hasMatch = Object.values(match).some((list) => list.length > 0);
  return {
    title: form.title.trim(),
    body: form.body.trim(),
    category: form.category.trim() || "instruction",
    severity: form.severity,
    enabled: form.enabled,
    priority: Number(form.priority) || 100,
    match: hasMatch ? match : null,
  };
}

async function saveRule(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = null;
  const wasEditing = Boolean(editingId.value);
  try {
    const payload = buildPayload();
    if (editingId.value) {
      await props.api.patch<GlobalRule>(`/api/global-rules/${encodeURIComponent(editingId.value)}`, payload);
    } else {
      await props.api.post<GlobalRule>("/api/global-rules", payload);
    }
    await loadRules();
    editingId.value = null;
    dialogOpen.value = false;
    assignForm(emptyForm());
    statusMessage.value = wasEditing ? "规则已保存" : "规则已创建";
    emit("changed");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

async function patchRule(
  rule: GlobalRule,
  patch: Record<string, unknown>,
  successMessage: string,
): Promise<void> {
  if (busy.value) return;
  busyRowId.value = rule.id;
  error.value = null;
  statusMessage.value = null;
  try {
    await props.api.patch<GlobalRule>(`/api/global-rules/${encodeURIComponent(rule.id)}`, patch);
    await loadRules();
    statusMessage.value = successMessage;
    emit("changed");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busyRowId.value = null;
  }
}

function toggleEnabled(rule: GlobalRule): void {
  const next = !rule.enabled;
  void patchRule(rule, { enabled: next }, next ? `已启用「${rule.title}」` : `已停用「${rule.title}」`);
}

function requestDelete(rule: GlobalRule): void {
  if (busy.value) return;
  pendingDeleteId.value = rule.id;
  statusMessage.value = null;
  error.value = null;
}

function cancelDelete(): void {
  pendingDeleteId.value = null;
}

async function deleteRule(rule: GlobalRule): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = null;
  try {
    await props.api.delete<{ success: boolean }>(`/api/global-rules/${encodeURIComponent(rule.id)}`);
    if (editingId.value === rule.id) closeDialog();
    await loadRules();
    pendingDeleteId.value = null;
    statusMessage.value = "规则已删除";
    emit("changed");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

async function runRuleTest(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  error.value = null;
  try {
    testResult.value = await props.api.post<RuleEnforcementResult>("/api/global-rules/test", {
      agent: testForm.agent.trim() || "codex",
      channel: testForm.channel.trim() || "web",
      tool: testForm.tool.trim() || "shell",
      command: testForm.command,
      userExplicitlyApproved: testForm.userExplicitlyApproved,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    testResult.value = null;
  } finally {
    testing.value = false;
  }
}

onMounted(() => {
  void loadRules();
});

defineExpose({
  refresh: loadRules,
  create: startCreate,
});
</script>

<template>
  <section class="ruleManager" data-testid="global-rule-manager">
    <header v-if="showHeader" class="ruleHeader" data-drag-handle>
      <div class="ruleHeaderTitle">
        <div class="ruleTitle">全局规则</div>
        <div class="ruleSubtitle">
          保存后下一轮请求即生效，Web / Telegram / Codex / Claude 共用同一份启用规则。
        </div>
      </div>
      <div class="ruleHeaderActions">
        <button class="ruleIconBtn" type="button" title="刷新" :disabled="busy" @click="loadRules">
          <el-icon :size="16" aria-hidden="true"><Refresh /></el-icon>
        </button>
        <button class="ruleIconBtn" type="button" title="关闭" @click="emit('close')">
          <el-icon :size="16" aria-hidden="true"><Close /></el-icon>
        </button>
      </div>
    </header>

    <div v-if="error && !dialogOpen" class="ruleBanner error" data-testid="global-rule-error">{{ error }}</div>
    <div v-else-if="statusMessage && !dialogOpen" class="ruleBanner success" data-testid="global-rule-status">
      {{ statusMessage }}
    </div>
    <div v-if="preview?.degraded" class="ruleBanner error" data-testid="global-rule-degraded">
      规则数据库不可用，当前降级为只读 bootstrap 规则（templates/rules.md）。
    </div>

    <nav class="ruleTabs" aria-label="全局规则分区">
      <button
        v-for="tab in TABS"
        :key="tab.key"
        type="button"
        class="ruleTab"
        :class="{ active: activeTab === tab.key }"
        :aria-selected="activeTab === tab.key"
        role="tab"
        @click="activeTab = tab.key"
      >
        <el-icon :size="13" aria-hidden="true"><component :is="tab.icon" /></el-icon>
        <span>{{ tab.label }}</span>
        <span v-if="tab.key === 'rules'" class="tabBadge">{{ rules.length }}</span>
        <span v-else-if="tab.key === 'audit' && auditEntries.length" class="tabBadge muted">{{ auditEntries.length }}</span>
      </button>
      <button v-if="showAddButton" type="button" class="addBtn" :disabled="busy" data-testid="global-rule-add" @click="startCreate">
        <el-icon :size="13" aria-hidden="true"><Plus /></el-icon>
        <span>新增规则</span>
      </button>
    </nav>

    <div class="ruleBody">
      <div v-show="activeTab === 'rules'" class="tabPane" role="tabpanel">
        <div class="paneMeta">{{ rules.length }} 条规则 · {{ enabledCount }} 已启用 · 按优先级排序</div>

        <div class="listCard">
          <div v-if="sortedRules.length === 0" class="ruleEmpty">
            <el-icon :size="26" aria-hidden="true"><Document /></el-icon>
            <p>还没有规则</p>
            <p class="ruleEmptyHint">新增后会立即注入所有 agent，无需重启服务。</p>
          </div>

          <article
            v-for="rule in sortedRules"
            :key="rule.id"
            class="ruleRow"
            :class="{ off: !rule.enabled, busy: busyRowId === rule.id }"
            :data-testid="`global-rule-row-${rule.id}`"
          >
            <span class="sevBar" :class="`sev-${rule.severity}`" aria-hidden="true" />
            <div class="ruleRowMain">
              <span class="ruleRowName">
                <span class="ruleRowText">{{ rule.title }}</span>
                <span class="rulePill" :class="`sev-${rule.severity}`">{{ rule.severity }}</span>
                <span class="rulePill category">{{ rule.category }}</span>
                <span v-if="isEnforceable(rule)" class="rulePill enforce">可拦截</span>
              </span>
              <span v-if="bodyExcerpt(rule.body)" class="ruleRowExcerpt">{{ bodyExcerpt(rule.body) }}</span>
              <span class="ruleRowMeta">
                优先级 {{ rule.priority }} · 更新于 {{ formatTime(rule.updatedAt)
                }}<template v-if="rule.updatedBy"> · {{ rule.updatedBy }}</template>
                <template v-if="matchSummary(rule)"> · {{ matchSummary(rule) }}</template>
              </span>
            </div>

            <div class="ruleRowActions">
              <template v-if="pendingDeleteId === rule.id">
                <span class="confirmText">确定删除？</span>
                <button
                  type="button"
                  class="rowAction danger solid"
                  :disabled="busy"
                  :data-testid="`global-rule-delete-confirm-${rule.id}`"
                  @click="deleteRule(rule)"
                >
                  确认删除
                </button>
                <button type="button" class="rowAction" :disabled="busy" @click="cancelDelete">取消</button>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="rowSwitch"
                  :class="{ on: rule.enabled }"
                  role="switch"
                  :aria-checked="rule.enabled"
                  :title="rule.enabled ? '点击停用（不再注入与评估）' : '点击启用'"
                  :disabled="busy"
                  :data-testid="`global-rule-toggle-${rule.id}`"
                  @click="toggleEnabled(rule)"
                >
                  <span class="rowSwitchTrack" aria-hidden="true"><span class="rowSwitchThumb" /></span>
                  <span class="rowSwitchText">{{ rule.enabled ? "已启用" : "已停用" }}</span>
                </button>

                <button
                  type="button"
                  class="rowAction icon"
                  title="编辑"
                  :disabled="busy"
                  :data-testid="`global-rule-edit-${rule.id}`"
                  @click="editRule(rule)"
                >
                  <el-icon :size="14" aria-hidden="true"><EditPen /></el-icon>
                </button>

                <button
                  type="button"
                  class="rowAction icon danger"
                  title="删除"
                  :disabled="busy"
                  :data-testid="`global-rule-delete-${rule.id}`"
                  @click="requestDelete(rule)"
                >
                  <el-icon :size="14" aria-hidden="true"><Delete /></el-icon>
                </button>
              </template>
            </div>
          </article>
        </div>
      </div>

      <div v-show="activeTab === 'test'" class="tabPane" role="tabpanel">
        <div class="paneMeta">模拟一次工具调用，查看命中规则与最终决定，不会真正执行。</div>

        <div class="panelCard">
          <div class="testGrid">
            <label class="ruleField">
              <span class="ruleLabel">agent</span>
              <input v-model="testForm.agent" class="ruleInput" data-testid="global-rule-test-agent" />
            </label>
            <label class="ruleField">
              <span class="ruleLabel">channel</span>
              <input v-model="testForm.channel" class="ruleInput" data-testid="global-rule-test-channel" />
            </label>
            <label class="ruleField">
              <span class="ruleLabel">tool</span>
              <input v-model="testForm.tool" class="ruleInput" data-testid="global-rule-test-tool" />
            </label>
          </div>
          <label class="ruleField">
            <span class="ruleLabel">命令</span>
            <input
              v-model="testForm.command"
              class="ruleInput mono"
              placeholder="pkill -f node"
              spellcheck="false"
              data-testid="global-rule-test-command"
            />
          </label>
          <div class="testFooter">
            <label class="ruleToggle">
              <input
                v-model="testForm.userExplicitlyApproved"
                type="checkbox"
                data-testid="global-rule-test-approved"
              />
              <span><strong>用户已明确授权</strong><small>勾选后 approval_required 规则放行。</small></span>
            </label>
            <button
              type="button"
              class="btnPrimary testRunBtn"
              :disabled="testing"
              data-testid="global-rule-test-run"
              @click="runRuleTest"
            >
              {{ testing ? "评估中…" : "评估" }}
            </button>
          </div>
        </div>

        <div v-if="testResult" class="testResult" data-testid="global-rule-test-result">
          <div class="testDecision" :class="`decision-${testResult.decision}`">
            <el-icon :size="15" aria-hidden="true"><component :is="decisionIcon" /></el-icon>
            <span>
              {{ DECISION_LABELS[testResult.decision] }}（{{ testResult.decision }}） · 运行时模式：{{
                MODE_LABELS[testResult.mode]
              }}
            </span>
          </div>
          <p v-if="testResult.hits.length === 0" class="testNoHit">没有规则命中。</p>
          <ul v-else class="hitList">
            <li v-for="hit in testResult.hits" :key="`${hit.ruleId}-${hit.matchedOn}`">
              <span class="rulePill" :class="`sev-${hit.severity}`">{{ hit.severity }}</span>
              <span class="hitTitle">{{ hit.title }}</span>
              <code class="hitMatch">{{ hit.matchedOn }}</code>
            </li>
          </ul>
        </div>
      </div>

      <div v-show="activeTab === 'preview'" class="tabPane fill" role="tabpanel">
        <div class="paneMeta">
          实际注入到 system prompt 的文本
          <template v-if="preview">
            · 来源 {{ preview.source }} · {{ preview.ruleCount }} 条 · {{ preview.hash.slice(0, 8) }}
          </template>
        </div>
        <pre class="previewBox" data-testid="global-rule-preview">{{ preview?.text || "（当前没有启用规则）" }}</pre>
      </div>

      <div v-show="activeTab === 'audit'" class="tabPane" role="tabpanel">
        <div class="paneMeta">规则的每一次创建、修改、启停与删除都会留痕。</div>
        <p v-if="auditEntries.length === 0" class="testNoHit">暂无修改记录。</p>
        <ul v-else class="auditList" data-testid="global-rule-audit">
          <li v-for="entry in auditEntries" :key="entry.id">
            <span class="rulePill" :class="`action-${entry.action}`">{{ AUDIT_ACTION_LABELS[entry.action] }}</span>
            <span class="auditTitle">{{ entry.after?.title ?? entry.before?.title ?? entry.ruleId }}</span>
            <span class="auditMeta">{{ formatTime(entry.ts) }} · {{ entry.actor ?? "unknown" }}</span>
          </li>
        </ul>
      </div>
    </div>

    <div v-if="dialogOpen" class="dialogMask" @click.self="closeDialog">
      <form class="dialogCard" role="dialog" aria-modal="true" data-testid="global-rule-dialog" @submit.prevent="saveRule">
        <header class="dialogHeader">
          <div class="dialogHeading">
            <div class="dialogTitle">{{ isEditing ? "编辑规则" : "新增规则" }}</div>
            <div class="dialogHint">保存后下一轮请求即生效，无需重启服务。</div>
          </div>
          <button class="ruleIconBtn" type="button" title="关闭" @click="closeDialog">
            <el-icon :size="16" aria-hidden="true"><Close /></el-icon>
          </button>
        </header>

        <div class="dialogBody">
          <div v-if="error" class="ruleBanner error dialogError" data-testid="global-rule-dialog-error">{{ error }}</div>

          <label class="ruleField">
            <span class="ruleLabel">标题<span class="required">必填</span></span>
            <input
              v-model="form.title"
              class="ruleInput"
              placeholder="例如：进程自保"
              autocomplete="off"
              data-testid="global-rule-title"
            />
          </label>

          <label class="ruleField">
            <span class="ruleLabel">规则正文<span class="required">必填</span></span>
            <textarea
              v-model="form.body"
              class="ruleTextarea"
              rows="4"
              placeholder="禁止 pkill / killall 杀掉 ads-web、ads-tg 进程……"
              data-testid="global-rule-body"
            />
            <span class="ruleHelp">原样注入给 agent，写清楚“做什么 / 不做什么”。</span>
          </label>

          <div class="twoCol">
            <label class="ruleField">
              <span class="ruleLabel">分类</span>
              <input
                v-model="form.category"
                class="ruleInput"
                autocomplete="off"
                data-testid="global-rule-category"
              />
              <span class="chipRow">
                <button
                  v-for="item in CATEGORIES"
                  :key="item"
                  type="button"
                  class="chip"
                  :class="{ on: form.category === item }"
                  @click="form.category = item"
                >
                  {{ item }}
                </button>
              </span>
            </label>

            <label class="ruleField">
              <span class="ruleLabel">优先级</span>
              <input
                v-model.number="form.priority"
                class="ruleInput"
                type="number"
                data-testid="global-rule-priority"
              />
              <span class="ruleHelp">数字越小越靠前。</span>
            </label>
          </div>

          <div class="ruleField">
            <span class="ruleLabel">级别</span>
            <div class="sevOptions" role="radiogroup" data-testid="global-rule-severity">
              <label
                v-for="item in SEVERITIES"
                :key="item.value"
                class="sevOption"
                :class="[`sev-${item.value}`, { sel: form.severity === item.value }]"
              >
                <input v-model="form.severity" type="radio" name="global-rule-severity" :value="item.value" />
                <span class="sevName"><span class="sevDot" aria-hidden="true" />{{ item.label }}</span>
                <span class="sevHint">{{ item.hint }}</span>
              </label>
            </div>
          </div>

          <div class="settingRow">
            <div class="settingText">
              <strong>启用规则</strong>
              <small>停用后既不注入也不参与执行评估。</small>
            </div>
            <label class="switch">
              <input v-model="form.enabled" type="checkbox" data-testid="global-rule-enabled" />
              <span class="switchTrack" aria-hidden="true"><span class="switchThumb" /></span>
            </label>
          </div>

          <div class="matchDivider">
            <span>拦截匹配（可选）</span>
            <small>留空则该规则只注入、不参与拦截</small>
          </div>

          <div class="ruleGrid">
            <label class="ruleField">
              <span class="ruleLabel">限定 agent</span>
              <input v-model="form.agents" class="ruleInput" placeholder="codex, claude" data-testid="global-rule-agents" />
            </label>
            <label class="ruleField">
              <span class="ruleLabel">限定 channel</span>
              <input v-model="form.channels" class="ruleInput" placeholder="web, telegram" data-testid="global-rule-channels" />
            </label>
            <label class="ruleField">
              <span class="ruleLabel">限定 tool</span>
              <input v-model="form.tools" class="ruleInput" placeholder="shell" data-testid="global-rule-tools" />
            </label>
          </div>

          <label class="ruleField">
            <span class="ruleLabel">命令匹配（每行一个正则）</span>
            <textarea
              v-model="form.commandPatterns"
              class="ruleTextarea mono"
              :class="{ invalid: invalidPatterns.length > 0 }"
              rows="3"
              placeholder="\bpkill\b"
              spellcheck="false"
              data-testid="global-rule-command-patterns"
            />
          </label>

          <label class="ruleField">
            <span class="ruleLabel">路径匹配（每行一个正则）</span>
            <textarea
              v-model="form.pathPatterns"
              class="ruleTextarea mono"
              :class="{ invalid: invalidPatterns.length > 0 }"
              rows="2"
              placeholder="/etc/.*"
              spellcheck="false"
              data-testid="global-rule-path-patterns"
            />
            <span v-if="invalidPatterns.length" class="ruleHelp invalid">
              正则无法编译：{{ invalidPatterns.join(", ") }}
            </span>
          </label>
        </div>

        <footer class="dialogActions">
          <button type="button" class="btnSecondary" :disabled="saving" @click="closeDialog">取消</button>
          <button type="submit" class="btnPrimary" :disabled="!canSubmit" data-testid="global-rule-save">
            {{ saving ? "保存中…" : "保存规则" }}
          </button>
        </footer>
      </form>
    </div>
  </section>
</template>

<style scoped>
.ruleManager {
  position: relative;
  width: 100%;
  height: min(700px, 88vh);
  max-height: min(700px, 88vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  border-radius: 16px;
}

/* ---------- header ---------- */
.ruleHeader {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.ruleHeaderTitle {
  min-width: 0;
}

.ruleTitle {
  font-size: 15px;
  font-weight: 800;
  color: var(--text);
  letter-spacing: 0.2px;
}

.ruleSubtitle {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--muted);
}

.ruleHeaderActions {
  display: flex;
  gap: 4px;
}

.ruleIconBtn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.ruleIconBtn:hover:not(:disabled) {
  background: rgba(15, 23, 42, 0.06);
  color: var(--text);
}

.ruleIconBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---------- banners ---------- */
.ruleBanner {
  flex: 0 0 auto;
  margin: 10px 16px 0;
  border-radius: 9px;
  padding: 8px 11px;
  font-size: 12px;
  font-weight: 600;
}

.ruleBanner.error {
  border: 1px solid rgba(239, 68, 68, 0.28);
  background: rgba(239, 68, 68, 0.07);
  color: var(--danger-2);
}

.ruleBanner.success {
  border: 1px solid rgba(16, 185, 129, 0.26);
  background: rgba(16, 185, 129, 0.07);
  color: #047857;
}

/* ---------- tabs ---------- */
.ruleTabs {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 16px 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.ruleTab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: -1px;
  padding: 8px 10px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
  transition: color 0.14s ease, border-color 0.14s ease;
}

.ruleTab:hover {
  color: var(--text);
}

.ruleTab.active {
  color: var(--accent-2);
  border-bottom-color: var(--accent);
}

.tabBadge {
  border-radius: 999px;
  padding: 0 7px;
  background: rgba(37, 99, 235, 0.1);
  color: var(--accent-2);
  font-size: 10.5px;
  font-weight: 800;
  line-height: 16px;
}

.tabBadge.muted {
  background: rgba(100, 116, 139, 0.12);
  color: #475569;
}

.ruleTabs .addBtn {
  margin-left: auto;
  margin-bottom: 6px;
}

/* ---------- body & panes ---------- */
.ruleBody {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 16px;
}

.tabPane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tabPane.fill {
  flex: 1 1 auto;
  min-height: 0;
}

.paneMeta {
  color: var(--muted-2);
  font-size: 11px;
  font-weight: 600;
  padding: 0 2px;
}

.panelCard,
.listCard {
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--surface);
  overflow: hidden;
}

.panelCard {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
}

/* ---------- add button ---------- */
.addBtn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(37, 99, 235, 0.3);
  transition: background 0.14s ease, transform 0.14s ease;
}

.addBtn:hover:not(:disabled) {
  background: var(--accent-2);
}

.addBtn:active:not(:disabled) {
  transform: translateY(1px);
}

.addBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------- empty state ---------- */
.ruleEmpty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 30px 14px;
  color: var(--muted-2);
  font-size: 12.5px;
  font-weight: 700;
}

.ruleEmpty p {
  margin: 0;
}

.ruleEmptyHint {
  font-size: 11px;
  font-weight: 400;
}

/* ---------- rule rows ---------- */
.ruleRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  transition: background 0.14s ease, opacity 0.14s ease;
}

.ruleRow:first-child {
  border-top: none;
}

.ruleRow:hover {
  background: rgba(37, 99, 235, 0.03);
}

.ruleRow.off .ruleRowText,
.ruleRow.off .ruleRowExcerpt {
  color: var(--muted-2);
}

.ruleRow.busy {
  opacity: 0.6;
  pointer-events: none;
}

.sevBar {
  flex: 0 0 auto;
  align-self: stretch;
  width: 3px;
  border-radius: 999px;
  background: rgba(100, 116, 139, 0.35);
}

.sevBar.sev-blocked {
  background: var(--danger-2);
}

.sevBar.sev-approval_required {
  background: #f59e0b;
}

.sevBar.sev-required {
  background: var(--accent);
}

.ruleRowMain {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ruleRowName {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.ruleRowText {
  overflow: hidden;
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ruleRowExcerpt {
  overflow: hidden;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ruleRowMeta {
  overflow: hidden;
  color: var(--muted-2);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- pills ---------- */
.rulePill {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.2px;
}

.rulePill.sev-blocked {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger-2);
}

.rulePill.sev-approval_required {
  background: rgba(245, 158, 11, 0.14);
  color: #b45309;
}

.rulePill.sev-required {
  background: rgba(37, 99, 235, 0.1);
  color: var(--accent-2);
}

.rulePill.sev-advisory,
.rulePill.category {
  background: rgba(100, 116, 139, 0.12);
  color: #475569;
}

.rulePill.enforce {
  background: rgba(16, 185, 129, 0.12);
  color: #047857;
}

.rulePill.action-create,
.rulePill.action-enable {
  background: rgba(16, 185, 129, 0.12);
  color: #047857;
}

.rulePill.action-update {
  background: rgba(37, 99, 235, 0.1);
  color: var(--accent-2);
}

.rulePill.action-disable {
  background: rgba(245, 158, 11, 0.14);
  color: #b45309;
}

.rulePill.action-delete {
  background: rgba(239, 68, 68, 0.1);
  color: var(--danger-2);
}

/* ---------- row actions ---------- */
.ruleRowActions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.confirmText {
  color: var(--danger-2);
  font-size: 11.5px;
  font-weight: 700;
}

.rowSwitch {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: border-color 0.14s ease, color 0.14s ease;
}

.rowSwitch:hover:not(:disabled) {
  border-color: rgba(100, 116, 139, 0.5);
}

.rowSwitch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rowSwitchTrack {
  position: relative;
  width: 26px;
  height: 15px;
  border-radius: 999px;
  background: #cbd5e1;
  transition: background 0.16s ease;
}

.rowSwitchThumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
  transition: transform 0.16s ease;
}

.rowSwitch.on {
  border-color: rgba(16, 185, 129, 0.4);
  color: #047857;
}

.rowSwitch.on .rowSwitchTrack {
  background: #10b981;
}

.rowSwitch.on .rowSwitchThumb {
  transform: translateX(11px);
}

.rowAction {
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: #475569;
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}

.rowAction.icon {
  width: 28px;
  padding: 0;
}

.rowAction:hover:not(:disabled) {
  border-color: rgba(100, 116, 139, 0.45);
  background: var(--surface-2);
  color: var(--text);
}

.rowAction.danger {
  color: var(--danger-2);
}

.rowAction.danger:hover:not(:disabled) {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.07);
  color: var(--danger-2);
}

.rowAction.danger.solid {
  border-color: var(--danger-2);
  background: var(--danger-2);
  color: #fff;
}

.rowAction.danger.solid:hover:not(:disabled) {
  background: #b91c1c;
  color: #fff;
}

.rowAction:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---------- fields ---------- */
.ruleField {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.ruleLabel {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #334155;
  font-size: 11.5px;
  font-weight: 800;
  letter-spacing: 0.2px;
}

.required {
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(37, 99, 235, 0.1);
  color: var(--accent-2);
  font-size: 9.5px;
  font-weight: 800;
}

.ruleInput,
.ruleTextarea {
  width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.42);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  box-sizing: border-box;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}

.ruleInput {
  height: 34px;
  padding: 0 11px;
}

.ruleTextarea {
  padding: 9px 11px;
  line-height: 1.5;
  resize: vertical;
}

.ruleInput.mono,
.ruleTextarea.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.ruleInput:focus,
.ruleTextarea:focus {
  outline: none;
  border-color: rgba(37, 99, 235, 0.6);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.ruleTextarea.invalid {
  border-color: rgba(239, 68, 68, 0.55);
}

.ruleTextarea.invalid:focus {
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.12);
}

.ruleHelp {
  color: var(--muted-2);
  font-size: 10.5px;
  line-height: 1.5;
}

.ruleHelp.invalid {
  color: var(--danger-2);
  font-weight: 700;
}

.ruleGrid,
.testGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}

.twoCol {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 140px;
  gap: 10px;
}

/* ---------- chips ---------- */
.chipRow {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  padding: 2px 10px;
  font-size: 10.5px;
  font-weight: 700;
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease, color 0.14s ease;
}

.chip:hover {
  border-color: rgba(37, 99, 235, 0.45);
  color: var(--accent-2);
}

.chip.on {
  border-color: rgba(37, 99, 235, 0.55);
  background: rgba(37, 99, 235, 0.08);
  color: var(--accent-2);
}

/* ---------- severity segmented options ---------- */
.sevOptions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.sevOption {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease, box-shadow 0.14s ease;
}

.sevOption:hover {
  border-color: rgba(100, 116, 139, 0.4);
}

.sevOption input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.sevName {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #334155;
  font-size: 11.5px;
  font-weight: 800;
}

.sevDot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #94a3b8;
}

.sevHint {
  color: var(--muted-2);
  font-size: 10px;
  line-height: 1.45;
}

.sevOption.sev-required .sevDot {
  background: var(--accent);
}

.sevOption.sev-approval_required .sevDot {
  background: #f59e0b;
}

.sevOption.sev-blocked .sevDot {
  background: var(--danger-2);
}

.sevOption.sel.sev-advisory {
  border-color: rgba(100, 116, 139, 0.55);
  background: rgba(100, 116, 139, 0.08);
}

.sevOption.sel.sev-required {
  border-color: rgba(37, 99, 235, 0.55);
  background: rgba(37, 99, 235, 0.07);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.08);
}

.sevOption.sel.sev-approval_required {
  border-color: rgba(245, 158, 11, 0.55);
  background: rgba(245, 158, 11, 0.08);
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.1);
}

.sevOption.sel.sev-blocked {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.06);
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.08);
}

/* ---------- setting row with switch ---------- */
.settingRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-2);
}

.settingText {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settingText strong {
  color: #334155;
  font-size: 12px;
}

.settingText small {
  color: var(--muted-2);
  font-size: 10px;
  line-height: 1.45;
}

.switch {
  flex: 0 0 auto;
  position: relative;
  display: inline-block;
  cursor: pointer;
}

.switch input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
}

.switchTrack {
  display: block;
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: #cbd5e1;
  transition: background 0.16s ease;
}

.switchThumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
  transition: transform 0.16s ease;
}

.switch input:checked + .switchTrack {
  background: #10b981;
}

.switch input:checked + .switchTrack .switchThumb {
  transform: translateX(16px);
}

.switch input:focus-visible + .switchTrack {
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
}

/* ---------- test pane ---------- */
.ruleToggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}

.ruleToggle input {
  margin-top: 2px;
  accent-color: var(--accent);
}

.ruleToggle span {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ruleToggle strong {
  color: #334155;
  font-size: 12px;
}

.ruleToggle small {
  color: var(--muted-2);
  font-size: 10px;
  line-height: 1.45;
}

.testFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.testRunBtn {
  flex: 0 0 auto;
}

.testResult {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.testDecision {
  display: flex;
  align-items: center;
  gap: 7px;
  border-radius: 9px;
  padding: 8px 11px;
  font-size: 12.5px;
  font-weight: 800;
}

.testDecision.decision-allow {
  background: rgba(16, 185, 129, 0.1);
  color: #047857;
}

.testDecision.decision-require_approval {
  background: rgba(245, 158, 11, 0.13);
  color: #b45309;
}

.testDecision.decision-deny {
  background: rgba(239, 68, 68, 0.09);
  color: var(--danger-2);
}

.testNoHit {
  margin: 0;
  color: var(--muted-2);
  font-size: 11.5px;
}

.hitList,
.auditList {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hitList li {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-2);
}

.hitTitle {
  color: var(--text);
  font-size: 12px;
  font-weight: 700;
}

.hitMatch {
  overflow: hidden;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.05);
  color: #475569;
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- preview pane ---------- */
.previewBox {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  padding: 12px;
  color: #334155;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---------- audit pane ---------- */
.auditList li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-2);
}

.auditTitle {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 12px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.auditMeta {
  flex: 0 0 auto;
  color: var(--muted-2);
  font-size: 11px;
}

/* ---------- edit dialog ---------- */
.dialogMask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(15, 23, 42, 0.34);
  backdrop-filter: blur(2px);
}

.dialogCard {
  width: min(660px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 18px 44px rgba(15, 23, 42, 0.22);
}

.dialogHeader {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 12px 16px;
  border-bottom: 1px solid var(--border);
}

.dialogHeading {
  min-width: 0;
}

.dialogTitle {
  color: var(--text);
  font-size: 14.5px;
  font-weight: 800;
}

.dialogHint {
  margin-top: 5px;
  overflow: hidden;
  color: var(--muted-2);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialogBody {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 15px;
  padding: 16px;
}

/* Save failures must surface inside the dialog — the page-level banner sits under the mask. */
.dialogError {
  margin: 0;
}

.matchDivider {
  display: flex;
  align-items: baseline;
  gap: 10px;
  color: #334155;
  font-size: 11.5px;
  font-weight: 800;
  letter-spacing: 0.3px;
}

.matchDivider small {
  color: var(--muted-2);
  font-size: 10px;
  font-weight: 400;
}

.matchDivider::before,
.matchDivider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
  align-self: center;
}

.dialogActions {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}

.btnSecondary,
.btnPrimary {
  height: 34px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.14s ease;
}

.btnSecondary {
  background: var(--surface);
  color: var(--text);
}

.btnSecondary:hover:not(:disabled) {
  background: var(--surface-2);
}

.btnPrimary {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
}

.btnPrimary:hover:not(:disabled) {
  background: var(--accent-2);
}

.btnPrimary:disabled,
.btnSecondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .ruleManager {
    height: min(720px, 90vh);
    max-height: min(720px, 90vh);
  }

  .ruleTab span:not(.tabBadge) {
    display: none;
  }

  .ruleTab {
    padding: 8px;
  }

  .ruleRow {
    flex-wrap: wrap;
  }

  .ruleRowActions {
    width: 100%;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .sevOptions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .twoCol {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
