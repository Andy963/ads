import { resetAdmin } from "./resetAdmin.js";
import { pathToFileURL } from "node:url";

function printUsage(): void {
  console.error("Usage: npm run web:reset-admin -- --username <u> --password-stdin");
  console.error("  Or:  npm run web:reset-admin -- --username <u> --password <p>");
  console.error("  Or:  node dist/src/web/auth/resetAdminCli.js --username <u> --password-stdin");
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

export async function runResetAdminFromCli(args: string[]): Promise<number> {
  const rawUsername = parseFlagValue(args, "--username")?.trim() ?? "";
  const username = rawUsername.replace(/\.+$/g, "");
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

  const outcome = resetAdmin({ username, password });
  if (outcome.status === "created") {
    console.log(`OK (created user=${outcome.username} id=${outcome.userId})`);
    return 0;
  }
  console.log(`OK (updated user=${outcome.username} id=${outcome.userId} prev=${outcome.previousUsername})`);
  return 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const exitCode = await runResetAdminFromCli(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}
