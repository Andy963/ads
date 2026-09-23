import { createApp } from "vue";

import { ElIcon } from "element-plus";
import "element-plus/es/components/icon/style/css";

import App from "./App.vue";
import "./global.css";

import { installViewportCssVars } from "./lib/viewport";
import { eagerMigratePreferencesToV2 } from "./lib/preferencesStore";
import { diagAlert } from "./lib/diagAlert";
import { crumb, crumbSnapshot } from "./lib/diagBreadcrumbs";
import { notifyRuntimeRenderError } from "./lib/errorRecovery";
import { dumpCrashTrees } from "./lib/diagVNodeTree";

installViewportCssVars();
eagerMigratePreferencesToV2();

type RuntimeDiagnosticRecord = {
  source: "vue" | "window-error" | "unhandled-rejection";
  name: string;
  message: string;
  stack?: string;
  info?: string;
  component?: string;
  tree?: string;
  trail?: string;
  file?: string;
  line?: number;
  column?: number;
  ts: number;
};

const RUNTIME_DIAGNOSTICS_KEY = "ADS_RUNTIME_DIAGNOSTICS";
const RUNTIME_DIAGNOSTICS_LIMIT = 20;

function redactDiagnosticText(value: unknown, maxLength = 500): string {
  return String(value ?? "")
    .replace(/bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, maxLength);
}

function normalizeDiagnosticError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: redactDiagnosticText(error.name, 100) || "Error",
      message: redactDiagnosticText(error.message),
      ...(error.stack ? { stack: redactDiagnosticText(error.stack, 1200) } : {}),
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: redactDiagnosticText(error) };
  }
  return { name: "UnknownError", message: "Non-Error exception" };
}

// Keep the cycle marker in view: if the dump found an anomaly, show the nodes
// around it; otherwise show the head of the dump.
function excerptTree(tree: string, maxLength = 900): string {
  if (tree.length <= maxLength) return tree;
  const marker = tree.indexOf("⟳");
  if (marker < 0) return `${tree.slice(0, maxLength)}…`;
  const start = Math.max(0, marker - Math.floor(maxLength / 2));
  return `${start > 0 ? "…" : ""}${tree.slice(start, start + maxLength)}…`;
}

function recordRuntimeDiagnostic(
  source: RuntimeDiagnosticRecord["source"],
  error: unknown,
  metadata: Omit<RuntimeDiagnosticRecord, "source" | "name" | "message" | "stack" | "ts"> = {},
): void {
  const normalized = normalizeDiagnosticError(error);
  const component = metadata.component ? redactDiagnosticText(metadata.component, 500) : "";
  const trail = crumbSnapshot();
  const record: RuntimeDiagnosticRecord = {
    source,
    ...normalized,
    ...(metadata.info ? { info: redactDiagnosticText(metadata.info, 300) } : {}),
    ...(component ? { component } : {}),
    ...(metadata.tree ? { tree: redactDiagnosticText(metadata.tree, 2600) } : {}),
    ...(trail ? { trail: trail.slice(0, 400) } : {}),
    ...(metadata.file ? { file: redactDiagnosticText(metadata.file, 500) } : {}),
    ...(typeof metadata.line === "number" ? { line: metadata.line } : {}),
    ...(typeof metadata.column === "number" ? { column: metadata.column } : {}),
    ts: Date.now(),
  };

  const diagnosticWindow = window as Window & {
    __ADS_RUNTIME_DIAGNOSTICS__?: RuntimeDiagnosticRecord[];
  };
  const current = Array.isArray(diagnosticWindow.__ADS_RUNTIME_DIAGNOSTICS__)
    ? diagnosticWindow.__ADS_RUNTIME_DIAGNOSTICS__
    : [];
  diagnosticWindow.__ADS_RUNTIME_DIAGNOSTICS__ = [...current, record].slice(-RUNTIME_DIAGNOSTICS_LIMIT);
  const stackTop = record.stack ? `\n堆栈: ${record.stack.split("\n").slice(0, 6).join(" <- ")}` : "";
  const treeExcerpt = record.tree ? `\n树: ${excerptTree(record.tree)}` : "";
  diagAlert(
    `错误/${source}`,
    `${record.name}: ${record.message}${record.component ? ` @${record.component}` : ""}${record.info ? ` (${record.info})` : ""}${treeExcerpt}${stackTop}${trail ? `\n轨迹: ${trail}` : ""}`,
  );

  try {
    localStorage.setItem(RUNTIME_DIAGNOSTICS_KEY, JSON.stringify(diagnosticWindow.__ADS_RUNTIME_DIAGNOSTICS__));
  } catch {
    // Diagnostics must never interfere with application rendering.
  }
}

const app = createApp(App);
app.component("ElIcon", ElIcon);

function describeDomAnchor(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const el = node as {
    nodeType?: unknown;
    tagName?: unknown;
    id?: unknown;
    className?: unknown;
    getAttribute?: (name: string) => string | null;
  };
  if (typeof el.tagName !== "string") {
    return typeof el.nodeType === "number" ? `node(type=${el.nodeType})` : undefined;
  }
  const parts = [el.tagName.toLowerCase()];
  if (typeof el.id === "string" && el.id) parts.push(`#${el.id}`);
  if (typeof el.className === "string" && el.className.trim()) {
    parts.push(`.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`);
  }
  if (typeof el.getAttribute === "function") {
    for (const attr of ["data-testid", "data-id", "data-role", "data-kind", "data-panel-key"]) {
      const value = el.getAttribute(attr);
      if (value) parts.push(`[${attr.replace("data-", "")}=${String(value).slice(0, 40)}]`);
    }
  }
  return parts.join("");
}

function describeInstance(instance: unknown): string | undefined {
  if (!instance || typeof instance !== "object") return undefined;
  // Vue's errorHandler receives the component's PUBLIC proxy (`instance.proxy`),
  // not the internal instance — internals (uid/type/parent/vnode/subtree) live
  // under the `$` property. Reading them directly off the proxy yields
  // undefined across the board, which is why earlier reports said
  // "anonymous (root) {uid=undefined...}".
  const proxy = instance as { $?: unknown; $el?: unknown };
  const internalSource = proxy.$ && typeof proxy.$ === "object" ? proxy.$ : instance;
  const internal = internalSource as {
    type?: unknown;
    parent?: unknown;
    props?: Record<string, unknown>;
    uid?: unknown;
    isMounted?: unknown;
    vnode?: { el?: unknown; key?: unknown; type?: unknown };
    subtree?: { el?: unknown; type?: unknown };
  };
  const typeName = (type: unknown): string => {
    if (typeof type === "symbol") return type.toString();
    if (typeof type === "string") return type;
    if (typeof type === "function") {
      const fn = type as { displayName?: unknown; __name?: unknown; name?: unknown };
      return String(fn.displayName ?? fn.__name ?? fn.name ?? "anonymous(fn)");
    }
    if (type && typeof type === "object") {
      const record = type as { __name?: unknown; name?: unknown };
      return String(record.__name ?? record.name ?? "anonymous");
    }
    return "anonymous";
  };
  const parts: string[] = [typeName(internal.type)];
  let parent = internal.parent;
  for (let depth = 0; depth < 5 && parent && typeof parent === "object"; depth += 1) {
    const record = parent as { type?: unknown; parent?: unknown };
    parts.push(`<${typeName(record.type)}`);
    parent = record.parent;
  }
  if (!internal.parent) parts.push("(root)");
  const propKeys = Object.keys(internal.props ?? {}).join(",");
  if (propKeys) parts.push(`props:${propKeys}`);
  const anchor =
    describeDomAnchor(internal.vnode?.el) ??
    describeDomAnchor(internal.subtree?.el) ??
    describeDomAnchor(proxy.$el);
  if (anchor) parts.push(`@${anchor}`);
  if (internal.vnode && "key" in internal.vnode && internal.vnode.key != null) {
    parts.push(`key:${String(internal.vnode.key).slice(0, 60)}`);
  }
  // Raw identity dump: the pretty path above has produced misleading
  // "anonymous (root)" output on device, so include primitives directly.
  const raw: string[] = [];
  raw.push(`uid=${String(internal.uid)}`);
  raw.push(`typeOf=${typeof internal.type}`);
  raw.push(`mounted=${String(internal.isMounted)}`);
  const vnodeType = internal.vnode?.type;
  if (typeof vnodeType === "string" || typeof vnodeType === "symbol") raw.push(`vtag=${String(vnodeType)}`);
  const subtreeType = internal.subtree?.type;
  if (typeof subtreeType === "string" || typeof subtreeType === "symbol") raw.push(`subtag=${String(subtreeType)}`);
  try {
    if (internal.type && typeof internal.type === "object") {
      raw.push(`tkeys=${Object.keys(internal.type).slice(0, 8).join(",")}`);
    }
  } catch {
    // ignore
  }
  parts.push(`{${raw.join(";")}}`);
  return parts.join(" ");
}

app.config.errorHandler = (error, instance, info) => {
  const component = describeInstance(instance);
  const tree = dumpCrashTrees(instance);
  recordRuntimeDiagnostic("vue", error, { info, ...(component ? { component } : {}), ...(tree ? { tree } : {}) });
  notifyRuntimeRenderError(error, info);
};
window.addEventListener("error", (event) => {
  recordRuntimeDiagnostic("window-error", event.error ?? event.message, {
    file: event.filename,
    line: event.lineno,
    column: event.colno,
  });
});
window.addEventListener("unhandledrejection", (event) => {
  recordRuntimeDiagnostic("unhandled-rejection", event.reason);
});
document.addEventListener("visibilitychange", () => {
  crumb(`visibility:${document.visibilityState}`);
});
app.mount("#app");

// Surface the earliest diagnostic from the previous (possibly crashed) session.
// Cascade errors bury the origin; the first record is the one that matters.
try {
  const previous = localStorage.getItem(RUNTIME_DIAGNOSTICS_KEY);
  if (previous) {
    localStorage.removeItem(RUNTIME_DIAGNOSTICS_KEY);
    const records = JSON.parse(previous) as RuntimeDiagnosticRecord[];
    const earliest = Array.isArray(records) ? records.find((r) => r && r.source !== "unhandled-rejection") ?? records[0] : null;
    if (earliest) {
      const when = new Date(earliest.ts).toLocaleTimeString();
      diagAlert(
        "上次会话最早错误",
        `${when} [${earliest.source}] ${earliest.name}: ${earliest.message}${earliest.component ? ` @${earliest.component}` : ""}${earliest.tree ? ` 树: ${excerptTree(earliest.tree, 1200)}` : ""}${earliest.trail ? ` 轨迹: ${earliest.trail}` : ""}${earliest.stack ? ` 堆栈: ${earliest.stack.split("\n").slice(0, 4).join(" <- ")}` : ""}`,
      );
    }
  }
} catch {
  // Diagnostics must never break startup.
}
