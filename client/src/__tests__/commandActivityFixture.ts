export const commandActivityCases: Array<{ cmd: string; args: string[]; category: string }> = [
  { cmd: "ls", args: ["fixture.txt"], category: "List" },
  { cmd: "grep", args: ["needle", "fixture.txt"], category: "Search" },
  { cmd: "cat", args: ["fixture.txt"], category: "Read" },
  { cmd: "sed", args: ["-n", "1p", "fixture.txt"], category: "Read" },
  { cmd: "touch", args: ["created.txt"], category: "Write" },
  { cmd: "pwd", args: [], category: "Execute" },
];

export const commandCommentary = "I will inspect the fixture before summarizing it.";
export const commandFinalReply = "The fixture contains the expected needle.";

type ActivityFrame = {
  type: string;
  ts?: number;
  delta?: string;
  assistantItemId?: string;
  assistantItemText?: string;
  phase?: string;
  header?: boolean;
  entry?: { category: string; summary: string };
  command?: { id: string; command: string; status: string; exit_code?: number };
};

type ActivityEntry = {
  category: string;
  summary: string;
  source: string;
  meta?: { command?: string; tool?: string };
  ts: number;
};

export function collectCommandActivityFrames(): {
  frames: ActivityFrame[];
  entries: ActivityEntry[];
  commandFrameCount: number;
} {
  const frames: ActivityFrame[] = [];
  const entries: ActivityEntry[] = [];
  let timestamp = Date.now();
  const appendFrame = (frame: Omit<ActivityFrame, "ts">): void => {
    frames.push({ ...frame, ts: timestamp });
    timestamp += 1;
  };

  const commentaryId = "native-turn-fixture-message-0";
  appendFrame({ type: "delta", delta: commandCommentary, assistantItemId: commentaryId });
  appendFrame({
    type: "assistant_item",
    assistantItemId: commentaryId,
    assistantItemText: commandCommentary,
  });
  appendFrame({ type: "phase_complete", phase: "assistant" });

  for (const [index, command] of commandActivityCases.entries()) {
    const commandLine = [command.cmd, ...command.args].join(" ");
    entries.push({
      category: command.category,
      summary: command.category === "List"
        ? "fixture.txt"
        : command.category === "Search"
          ? "needle in fixture.txt"
          : command.category === "Write"
            ? "touch created.txt"
            : command.category === "Execute"
              ? "pwd"
              : "fixture.txt",
      source: "codex_event",
      meta: { command: commandLine },
      ts: timestamp,
    });
    appendFrame({
      type: "command",
      command: { id: `command-${index}`, command: commandLine, status: "in_progress" },
    });
    appendFrame({
      type: "command",
      command: { id: `command-${index}`, command: commandLine, status: "completed", exit_code: 0 },
    });
  }

  const finalId = "native-turn-fixture-message-6";
  appendFrame({ type: "delta", delta: commandFinalReply, assistantItemId: finalId });
  appendFrame({ type: "assistant_item", assistantItemId: finalId, assistantItemText: commandFinalReply });
  appendFrame({ type: "phase_complete", phase: "assistant" });
  const commandFrameCount = frames.length;

  const exploredEntries: Array<{ category: string; summary: string; tool?: string }> = [
    { category: "List", summary: "context.md in notes", tool: "find" },
    { category: "Search", summary: "context in notes", tool: "grep" },
    { category: "Read", summary: "notes/context.md", tool: "read" },
    { category: "Write", summary: "notes/summary.md", tool: "write" },
    { category: "WebSearch", summary: "reference documentation" },
  ];
  for (const [index, entry] of exploredEntries.entries()) {
    entries.push({
      category: entry.category,
      summary: entry.summary,
      source: entry.tool ? "tool_hook" : "codex_event",
      ...(entry.tool ? { meta: { tool: entry.tool } } : {}),
      ts: timestamp,
    });
    appendFrame({
      type: "explored",
      header: index === 0,
      entry: { category: entry.category, summary: entry.summary },
    });
  }

  return { frames, entries, commandFrameCount };
}
