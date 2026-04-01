/**
 * Reviewer snapshot context assembly.
 *
 * Helpers that parse the snapshot binding from the incoming payload,
 * build the read-only system prompt context from snapshot data, and
 * summarize reviewer artifact text for persistence.
 */

export function parseReviewerSnapshotId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const raw = record["snapshotId"] ?? record["snapshot_id"];
  const snapshotId = typeof raw === "string" ? raw.trim() : "";
  return snapshotId || null;
}

export function summarizeReviewerArtifactText(text: string): string {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "No reviewer summary provided.";
  }
  const firstParagraph = normalized.split(/\n\s*\n/)[0]?.trim() ?? normalized;
  const summary = firstParagraph || normalized;
  return summary.length <= 400 ? summary : `${summary.slice(0, 399)}…`;
}

export function buildReviewerSnapshotContext(args: {
  snapshot: {
    id: string;
    taskId: string;
    specRef: string | null;
    patch: { diff: string; truncated?: boolean } | null;
    changedFiles: string[];
    lintSummary: string;
    testSummary: string;
  };
  latestArtifact?: {
    id: string;
    summaryText: string;
    verdict: string;
    scope: string;
  } | null;
}): string {
  const { snapshot, latestArtifact } = args;
  const parts: string[] = [
    "You are the ADS reviewer lane.",
    "Stay read-only. Do not edit files, write patches, create drafts/specs/ADRs/schedules, or trigger workspace side effects.",
    "Base your analysis only on the immutable review snapshot below and the visible reviewer conversation.",
    "",
    "Review target:",
    `- taskId: ${snapshot.taskId}`,
    `- snapshotId: ${snapshot.id}`,
  ];
  if (snapshot.specRef) {
    parts.push(`- specRef: ${snapshot.specRef}`);
  }
  parts.push("", "Changed files:");
  if (snapshot.changedFiles.length === 0) {
    parts.push("- (none)");
  } else {
    for (const file of snapshot.changedFiles.slice(0, 200)) {
      parts.push(`- ${file}`);
    }
    if (snapshot.changedFiles.length > 200) {
      parts.push(`- ... (${snapshot.changedFiles.length - 200} more)`);
    }
  }
  if (snapshot.lintSummary || snapshot.testSummary) {
    parts.push("", "Validation summaries:");
    if (snapshot.lintSummary) parts.push(`- lint: ${snapshot.lintSummary}`);
    if (snapshot.testSummary) parts.push(`- test: ${snapshot.testSummary}`);
  }
  if (latestArtifact) {
    parts.push(
      "",
      "Latest persisted review artifact for this snapshot:",
      `- reviewArtifactId: ${latestArtifact.id}`,
      `- scope: ${latestArtifact.scope}`,
      `- verdict: ${latestArtifact.verdict}`,
      `- summary: ${latestArtifact.summaryText}`,
    );
  }
  parts.push(
    "",
    `Diff truncated: ${snapshot.patch?.truncated ? "yes" : "no"}`,
    "Diff:",
    "```diff",
    String(snapshot.patch?.diff ?? "").trimEnd().slice(0, 200_000),
    "```",
    "",
    "---",
    "",
  );
  return parts.join("\n");
}
