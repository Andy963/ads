import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-client-command-activity-state-"));
  const currentDirectory = path.resolve(process.cwd());
  const clientRoot = fs.existsSync(path.join(currentDirectory, "scripts", "command-activity-fixture.js"))
    ? currentDirectory
    : path.join(currentDirectory, "client");
  const scriptPath = path.join(clientRoot, "scripts", "command-activity-fixture.js");
  try {
    const output = execFileSync(process.execPath, [scriptPath], {
      cwd: path.dirname(clientRoot),
      env: { ...process.env, ADS_STATE_DIR: stateDir },
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(output) as {
      frames: ActivityFrame[];
      entries: ActivityEntry[];
      commandFrameCount: number;
    };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
