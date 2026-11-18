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

const DEFAULT_MAX_STEPS = 5;
const CATEGORY_LABEL_BY_KIND: Record<string, string> = {
  List: "List",
  Search: "Search",
  Read: "Read",
  Write: "Write",
  Execute: "Execute",
  Agent: "Agent",
  Tool: "Tool",
  WebSearch: "Web search",
};

function resolveMaxSteps(maxSteps: number): number {
  const parsed = Number.isFinite(maxSteps) ? Math.floor(maxSteps) : DEFAULT_MAX_STEPS;
  return parsed > 0 ? parsed : DEFAULT_MAX_STEPS;
}

export function createLiveActivityWindow(maxSteps = 5): LiveActivityWindow {
  return {
    maxSteps: resolveMaxSteps(maxSteps),
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
  const normalized = normalizeOneLine(category);
  const resolved = CATEGORY_LABEL_BY_KIND[normalized] ?? normalized;
  return resolved || "Activity";
}

function trimToMax(window: LiveActivityWindow): void {
  const max = window.maxSteps;
  if (window.steps.length <= max) return;
  window.steps = window.steps.slice(window.steps.length - max);
}

function consumePendingCommand(window: LiveActivityWindow): string | undefined {
  const pending = window.pendingCommand;
  if (!pending) {
    return undefined;
  }
  window.pendingCommand = null;
  return pending;
}

function findLastStepWithoutCommand(steps: LiveActivityStep[]): LiveActivityStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (!step.command) {
      return step;
    }
  }
  return null;
}

export function ingestExploredActivity(window: LiveActivityWindow, category: string, summary: string): void {
  const normalizedCategory = normalizeOneLine(category);
  const normalizedSummary = normalizeOneLine(summary);
  if (!normalizedSummary) return;

  const step: LiveActivityStep = { category: normalizedCategory, summary: normalizedSummary };
  const pending = consumePendingCommand(window);
  if (pending) {
    step.command = pending;
  }
  window.steps = [...window.steps, step];
  trimToMax(window);
}

export function ingestCommandActivity(window: LiveActivityWindow, command: string): void {
  const normalized = normalizeOneLine(command);
  if (!normalized) return;

  const target = findLastStepWithoutCommand(window.steps);
  if (target) {
    target.command = normalized;
    return;
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
