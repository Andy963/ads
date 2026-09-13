import { createApp } from "vue";

import { ElIcon } from "element-plus";
import "element-plus/es/components/icon/style/css";

import App from "./App.vue";
import "./global.css";

import { installViewportCssVars } from "./lib/viewport";

installViewportCssVars();

type RuntimeDiagnosticRecord = {
  source: "vue" | "window-error" | "unhandled-rejection";
  name: string;
  message: string;
  stack?: string;
  info?: string;
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

function recordRuntimeDiagnostic(
  source: RuntimeDiagnosticRecord["source"],
  error: unknown,
  metadata: Omit<RuntimeDiagnosticRecord, "source" | "name" | "message" | "stack" | "ts"> = {},
): void {
  const normalized = normalizeDiagnosticError(error);
  const record: RuntimeDiagnosticRecord = {
    source,
    ...normalized,
    ...(metadata.info ? { info: redactDiagnosticText(metadata.info, 300) } : {}),
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

  try {
    sessionStorage.setItem(RUNTIME_DIAGNOSTICS_KEY, JSON.stringify(diagnosticWindow.__ADS_RUNTIME_DIAGNOSTICS__));
  } catch {
    // Diagnostics must never interfere with application rendering.
  }
}

const app = createApp(App);
app.component("ElIcon", ElIcon);
app.config.errorHandler = (error, _instance, info) => {
  recordRuntimeDiagnostic("vue", error, { info });
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
app.mount("#app");
