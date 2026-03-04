export type DraftRecoveryErrorCode =
  | "SPEC_REQUIRED_BEFORE_DRAFT"
  | "SPEC_DIR_NOT_FOUND"
  | "SPEC_FILES_MISSING"
  | "SPEC_REF_REQUIRED_BEFORE_APPROVING_DRAFT"
  | "UNKNOWN";

export type DraftRecoveryErrorClassification = {
  recoverable: boolean;
  code: DraftRecoveryErrorCode;
  message: string;
  specRef: string | null;
};

function normalizeMessage(value: unknown): string {
  return String(value ?? "").trim();
}

function parseSpecRefAfterPrefix(message: string, prefix: string): string | null {
  if (!message.startsWith(prefix)) return null;
  const raw = message.slice(prefix.length).trim();
  return raw ? raw : null;
}

function parseSpecRefBeforeColon(message: string, prefix: string): string | null {
  if (!message.startsWith(prefix)) return null;
  const rest = message.slice(prefix.length);
  const idx = rest.indexOf(":");
  const raw = (idx >= 0 ? rest.slice(0, idx) : rest).trim();
  return raw ? raw : null;
}

export function classifyDraftSpecValidationError(messageInput: string): DraftRecoveryErrorClassification {
  const message = normalizeMessage(messageInput);
  if (!message) {
    return { recoverable: false, code: "UNKNOWN", message, specRef: null };
  }

  if (message === "spec is required before draft") {
    return { recoverable: true, code: "SPEC_REQUIRED_BEFORE_DRAFT", message, specRef: null };
  }

  if (message === "specRef is required before approving draft") {
    return { recoverable: true, code: "SPEC_REF_REQUIRED_BEFORE_APPROVING_DRAFT", message, specRef: null };
  }

  const dirNotFoundPrefix = "Spec directory not found:";
  const dirNotFoundSpecRef = parseSpecRefAfterPrefix(message, dirNotFoundPrefix);
  if (dirNotFoundSpecRef) {
    return { recoverable: true, code: "SPEC_DIR_NOT_FOUND", message, specRef: dirNotFoundSpecRef };
  }

  const filesMissingPrefix = "Spec files missing for ";
  const filesMissingSpecRef = parseSpecRefBeforeColon(message, filesMissingPrefix);
  if (filesMissingSpecRef) {
    return { recoverable: true, code: "SPEC_FILES_MISSING", message, specRef: filesMissingSpecRef };
  }

  return { recoverable: false, code: "UNKNOWN", message, specRef: null };
}

export function summarizeDraftSpecValidationErrors(messages: string[]): {
  recoverable: boolean;
  classifications: DraftRecoveryErrorClassification[];
  specRefToUpdate: string | null;
} {
  const normalized = (Array.isArray(messages) ? messages : [])
    .map((m) => normalizeMessage(m))
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  const classifications = unique.map((message) => classifyDraftSpecValidationError(message));
  const recoverable = classifications.length > 0 && classifications.every((c) => c.recoverable);
  const specRefToUpdate =
    classifications.find((c) => c.code === "SPEC_FILES_MISSING" && c.specRef)?.specRef ?? null;
  return { recoverable, classifications, specRefToUpdate };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatQuotedBlock(value: string): string {
  const lines = value.split("\n");
  return lines.map((line) => `> ${line}`).join("\n");
}

export function buildDraftRecoveryPrompt(args: {
  userRequest: string;
  firstPassOutput: string;
  taskBundleBlocks: string[];
  validationErrors: string[];
  requestId: string | null;
  specRefToUpdate: string | null;
}): string {
  const userRequest = normalizeMessage(args.userRequest) || "(empty)";
  const firstPassOutput = normalizeMessage(args.firstPassOutput) || "(empty)";
  const validationErrors = (Array.isArray(args.validationErrors) ? args.validationErrors : []).map(normalizeMessage).filter(Boolean);
  const uniqueErrors = Array.from(new Set(validationErrors));
  const taskBundleBlocks = (Array.isArray(args.taskBundleBlocks) ? args.taskBundleBlocks : [])
    .map((b) => normalizeMessage(b))
    .filter(Boolean);
  const requestId = normalizeMessage(args.requestId);
  const specRefToUpdate = normalizeMessage(args.specRefToUpdate);

  const errorsSection =
    uniqueErrors.length > 0 ? uniqueErrors.map((e) => `- ${e}`).join("\n") : "- (none)";

  const blocksSection =
    taskBundleBlocks.length > 0
      ? taskBundleBlocks
          .map((block, index) => {
            const header = `ads-tasks block #${index + 1}`;
            const body = truncateText(block, 2000);
            return [`### ${header}`, "```json", body, "```"].join("\n");
          })
          .join("\n\n")
      : "(no ads-tasks blocks extracted)";

  const specDirective = (() => {
    if (specRefToUpdate) {
      return [
        "Spec directive:",
        `- In the <<<spec>>> YAML, set specRef: "${specRefToUpdate}" to update that existing spec directory.`,
      ].join("\n");
    }
    return [
      "Spec directive:",
      "- In the <<<spec>>> YAML, do NOT set specRef (create a new spec directory under docs/spec).",
    ].join("\n");
  })();

  const requestIdDirective = requestId ? `- Set bundle.requestId to exactly: "${requestId}"` : "- Keep bundle.requestId stable (do not invent a new one).";

  return [
    "You are recovering a failed planner draft creation.",
    "",
    "The previous attempt was rejected by spec validation. Retry exactly once with a deterministic output.",
    "",
    "Recovery rules (must follow):",
    "1) First emit exactly ONE <<<spec ... >>> block (YAML).",
    "2) Then emit exactly ONE ```ads-tasks``` fenced block with TaskBundle v1 JSON.",
    "3) Do NOT emit any other fenced blocks.",
    "4) Do NOT set autoApprove (omit it).",
    `5) ${requestIdDirective}`,
    "6) In the ads-tasks JSON, omit specRef entirely (the system will attach the specRef created/updated above).",
    "7) Preserve the original task intent and constraints; do not drift.",
    "",
    specDirective,
    "",
    "Original user request:",
    formatQuotedBlock(truncateText(userRequest, 1200)),
    "",
    "First-pass assistant output (for reference):",
    formatQuotedBlock(truncateText(firstPassOutput, 2000)),
    "",
    "Spec validation errors:",
    errorsSection,
    "",
    "Extracted ads-tasks JSON block(s):",
    blocksSection,
    "",
    "Now produce the recovery output in the required order.",
  ].join("\n");
}
