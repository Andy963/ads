import { initAdmin } from "./initAdmin.js";

function printUsage(): void {
  console.error("Usage: npm run web:init-admin -- --username <u> --password-stdin");
  console.error("  Or:  npm run web:init-admin -- --username <u> --password <p>");
  console.error("  Or:  node dist/src/web/auth/initAdminCli.js --username <u> --password-stdin");
}

function parseFlagValue(args: string[], name: string): string | null {
  const prefixed = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === name) {
      const v = args[i + 1];
      return typeof v === "string" ? v : null;
    }
    if (a.startsWith(prefixed)) {
      return a.slice(prefixed.length);
    }
  }
  return null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
}

async function readStdinToString(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", (err) => reject(err));
  });
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/[\r\n]+$/g, "");
}

export async function runInitAdminFromCli(args: string[]): Promise<number> {
  const username = parseFlagValue(args, "--username")?.trim() ?? "";
  if (!username) {
    printUsage();
    return 2;
  }

  const passwordFromFlag = parseFlagValue(args, "--password");
  const wantsStdin = hasFlag(args, "--password-stdin");

  if (!passwordFromFlag && !wantsStdin) {
    printUsage();
    return 2;
  }
  if (passwordFromFlag && wantsStdin) {
    console.error("Error: use either --password or --password-stdin, not both.");
    return 2;
  }

  const password = wantsStdin ? stripTrailingNewlines(await readStdinToString()) : (passwordFromFlag ?? "");
  if (!password) {
    console.error("Error: password is empty.");
    return 2;
  }

  const outcome = initAdmin({ username, password });
  if (outcome.status === "already_initialized") {
    console.log("Already initialized");
    return 1;
  }

  console.log("OK");
  return 0;
}
