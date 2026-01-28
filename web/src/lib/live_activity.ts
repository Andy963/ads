export type LiveActivityStep = {
  category: string;
  summary: string;
  command?: string;
};

export type LiveActivityWindow = {
  maxSteps: number;
  steps: LiveActivityStep[];
  pendingCommand: string | null;
};

export function createLiveActivityWindow(maxSteps = 5): LiveActivityWindow {
  const parsed = Number.isFinite(maxSteps) ? Math.floor(maxSteps) : 5;
  return {
    maxSteps: parsed > 0 ? parsed : 5,
    steps: [],
    pendingCommand: null,
  };
}

export function clearLiveActivityWindow(window: LiveActivityWindow): void {
  window.steps = [];
  window.pendingCommand = null;
}

function normalizeOneLine(value: string): string {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function categoryLabel(category: string): string {
  const normalized = String(category ?? "").trim();
  switch (normalized) {
    case "List":
      return "List";
    case "Search":
      return "Search";
    case "Read":
      return "Read";
    case "Write":
      return "Write";
    case "Execute":
      return "Execute";
    case "Agent":
      return "Agent";
    case "Tool":
      return "Tool";
    case "WebSearch":
      return "Web search";
    default:
      return normalized || "Activity";
  }
}

function trimToMax(window: LiveActivityWindow): void {
  const max = window.maxSteps;
  if (window.steps.length <= max) return;
  window.steps = window.steps.slice(window.steps.length - max);
}

export function ingestExploredActivity(window: LiveActivityWindow, category: string, summary: string): void {
  const normalizedCategory = String(category ?? "").trim();
  const normalizedSummary = normalizeOneLine(summary);
  if (!normalizedSummary) return;

  const step: LiveActivityStep = { category: normalizedCategory, summary: normalizedSummary };
  if (window.pendingCommand) {
    step.command = window.pendingCommand;
    window.pendingCommand = null;
  }
  window.steps = [...window.steps, step];
  trimToMax(window);
}

export function ingestCommandActivity(window: LiveActivityWindow, command: string): void {
  const normalized = normalizeOneLine(command);
  if (!normalized) return;

  for (let i = window.steps.length - 1; i >= 0; i--) {
    const step = window.steps[i]!;
    if (!step.command) {
      step.command = normalized;
      return;
    }
  }

  window.pendingCommand = normalized;
}

export function renderLiveActivityMarkdown(window: LiveActivityWindow): string {
  if (!window.steps.length) return "";

  const lines: string[] = [];
  for (const step of window.steps) {
    const label = categoryLabel(step.category);
    const title = step.summary ? `${label}: ${step.summary}` : label;
    lines.push(`- **${title}**`);
  }
  return lines.join("\n");
}
