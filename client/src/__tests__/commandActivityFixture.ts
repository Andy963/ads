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

const RECORDED_COMMAND_ACTIVITY_FIXTURE: {
  frames: ActivityFrame[];
  entries: ActivityEntry[];
  commandFrameCount: number;
} = {"frames":[{"type":"delta","delta":"I will inspect the fixture before summarizing it.","assistantItemId":"native-turn-2ece3d4d-2e79-4e28-a23d-9df71c3f1383-message-0","ts":1795579336173},{"type":"assistant_item","assistantItemId":"native-turn-2ece3d4d-2e79-4e28-a23d-9df71c3f1383-message-0","assistantItemText":"I will inspect the fixture before summarizing it.","ts":1795579336177},{"type":"phase_complete","phase":"assistant","ts":1795579336177},{"type":"command","ts":1795579336177,"command":{"id":"command-0","command":"ls fixture.txt","status":"in_progress"}},{"type":"command","ts":1795579336211,"command":{"id":"command-0","command":"ls fixture.txt","status":"completed","exit_code":0}},{"type":"command","ts":1795579336213,"command":{"id":"command-1","command":"grep needle fixture.txt","status":"in_progress"}},{"type":"command","ts":1795579336219,"command":{"id":"command-1","command":"grep needle fixture.txt","status":"completed","exit_code":0}},{"type":"command","ts":1795579336220,"command":{"id":"command-2","command":"cat fixture.txt","status":"in_progress"}},{"type":"command","ts":1795579336225,"command":{"id":"command-2","command":"cat fixture.txt","status":"completed","exit_code":0}},{"type":"command","ts":1795579336227,"command":{"id":"command-3","command":"sed -n 1p fixture.txt","status":"in_progress"}},{"type":"command","ts":1795579336232,"command":{"id":"command-3","command":"sed -n 1p fixture.txt","status":"completed","exit_code":0}},{"type":"command","ts":1795579336233,"command":{"id":"command-4","command":"touch created.txt","status":"in_progress"}},{"type":"command","ts":1795579336238,"command":{"id":"command-4","command":"touch created.txt","status":"completed","exit_code":0}},{"type":"command","ts":1795579336239,"command":{"id":"command-5","command":"pwd","status":"in_progress"}},{"type":"command","ts":1795579336244,"command":{"id":"command-5","command":"pwd","status":"completed","exit_code":0}},{"type":"delta","delta":"The fixture contains the expected needle.","assistantItemId":"native-turn-2ece3d4d-2e79-4e28-a23d-9df71c3f1383-message-6","ts":1795579336246},{"type":"assistant_item","assistantItemId":"native-turn-2ece3d4d-2e79-4e28-a23d-9df71c3f1383-message-6","assistantItemText":"The fixture contains the expected needle.","ts":1795579336246},{"type":"phase_complete","phase":"assistant","ts":1795579336246},{"type":"explored","header":true,"entry":{"category":"List","summary":"context.md in notes"}},{"type":"explored","header":false,"entry":{"category":"Search","summary":"context in notes"}},{"type":"explored","header":false,"entry":{"category":"Read","summary":"notes/context.md"}},{"type":"explored","header":false,"entry":{"category":"Write","summary":"notes/summary.md"}},{"type":"explored","header":false,"entry":{"category":"WebSearch","summary":"reference documentation"}}],"entries":[{"category":"List","summary":"fixture.txt","source":"codex_event","meta":{"command":"ls fixture.txt"},"ts":1795579336181},{"category":"Search","summary":"needle in fixture.txt","source":"codex_event","meta":{"command":"grep needle fixture.txt"},"ts":1795579336213},{"category":"Read","summary":"fixture.txt","source":"codex_event","meta":{"command":"cat fixture.txt"},"ts":1795579336221},{"category":"Read","summary":"fixture.txt","source":"codex_event","meta":{"command":"sed -n 1p fixture.txt"},"ts":1795579336227},{"category":"Write","summary":"touch created.txt","source":"codex_event","meta":{"command":"touch created.txt"},"ts":1795579336234},{"category":"Execute","summary":"pwd","source":"codex_event","meta":{"command":"pwd"},"ts":1795579336240},{"category":"List","summary":"context.md in notes","source":"tool_hook","meta":{"tool":"find"},"ts":1795579336247},{"category":"Search","summary":"context in notes","source":"tool_hook","meta":{"tool":"grep"},"ts":1795579336247},{"category":"Read","summary":"notes/context.md","source":"tool_hook","meta":{"tool":"read"},"ts":1795579336247},{"category":"Write","summary":"notes/summary.md","source":"tool_hook","meta":{"tool":"write"},"ts":1795579336247},{"category":"WebSearch","summary":"reference documentation","source":"codex_event","ts":1795579336247}],"commandFrameCount":18};

export function collectCommandActivityFrames(): {
  frames: ActivityFrame[];
  entries: ActivityEntry[];
  commandFrameCount: number;
} {
  return structuredClone(RECORDED_COMMAND_ACTIVITY_FIXTURE);
}
