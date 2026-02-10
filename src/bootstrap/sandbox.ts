import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type SandboxBackend = "bwrap" | "none";

export type SandboxSpawnRequest = {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type SandboxSpawnSpec = {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export interface BootstrapSandbox {
  readonly backend: SandboxBackend;
  ensureAvailable(): void;
  wrapSpawn(request: SandboxSpawnRequest): SandboxSpawnSpec;
}

function existsDir(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function safeRealpath(targetPath: string): string {
  const resolved = path.resolve(String(targetPath ?? "").trim());
  if (!resolved) {
    return path.resolve(process.cwd());
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export class NoopSandbox implements BootstrapSandbox {
  readonly backend: SandboxBackend = "none";

  ensureAvailable(): void {
    // no-op
  }

  wrapSpawn(request: SandboxSpawnRequest): SandboxSpawnSpec {
    return { cmd: request.cmd, args: request.args, cwd: request.cwd, env: request.env };
  }
}

export class BwrapSandbox implements BootstrapSandbox {
  readonly backend: SandboxBackend = "bwrap";
  private readonly rootDir: string;
  private readonly worktreeDir: string;
  private readonly sandboxHomeHost: string;
  private readonly sandboxTmpHost: string;
  private readonly allowNetwork: boolean;

  constructor(options: { rootDir: string; worktreeDir?: string; allowNetwork?: boolean }) {
    this.rootDir = safeRealpath(options.rootDir);
    this.worktreeDir = safeRealpath(options.worktreeDir ?? options.rootDir);
    this.sandboxHomeHost = path.join(this.rootDir, "sandbox", "home");
    this.sandboxTmpHost = path.join(this.rootDir, "sandbox", "tmp");
    this.allowNetwork = options.allowNetwork !== false;
    fs.mkdirSync(this.sandboxHomeHost, { recursive: true });
    fs.mkdirSync(this.sandboxTmpHost, { recursive: true });
  }

  ensureAvailable(): void {
    const res = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
    if (res.error || res.status !== 0) {
      throw new Error("bwrap is required for hard sandboxing but is not available");
    }
  }

  private toSandboxPath(hostPath: string): string {
    const candidate = safeRealpath(hostPath);
    const rel = path.relative(this.worktreeDir, candidate);
    if (!rel || rel === ".") {
      return "/workspace";
    }
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes sandbox root: ${candidate}`);
    }
    const parts = rel.split(path.sep).filter(Boolean);
    return path.posix.join("/workspace", ...parts);
  }

  wrapSpawn(request: SandboxSpawnRequest): SandboxSpawnSpec {
    const sandboxCwd = this.toSandboxPath(request.cwd);

    const args: string[] = ["--die-with-parent", "--clearenv", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];

    if (!this.allowNetwork) {
      args.push("--unshare-net");
    }

    const roBind = (src: string, dest: string) => {
      if (!existsDir(src) && !fs.existsSync(src)) return;
      args.push("--ro-bind", src, dest);
    };

    roBind("/usr", "/usr");
    roBind("/bin", "/bin");
    roBind("/lib", "/lib");
    roBind("/lib64", "/lib64");
    roBind("/sbin", "/sbin");

    args.push("--proc", "/proc", "--dev", "/dev");

    args.push("--bind", this.worktreeDir, "/workspace");

    args.push("--dir", "/etc");
    if (fs.existsSync("/etc/resolv.conf")) {
      args.push("--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf");
    }
    if (existsDir("/etc/ssl/certs")) {
      args.push("--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs");
    }

    args.push("--bind", this.sandboxTmpHost, "/tmp");

    args.push("--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    args.push("--setenv", "HOME", "/workspace/sandbox/home");
    args.push("--setenv", "TMPDIR", "/tmp");
    args.push("--setenv", "XDG_CACHE_HOME", "/workspace/sandbox/home/.cache");
    args.push("--setenv", "XDG_CONFIG_HOME", "/workspace/sandbox/home/.config");
    args.push("--setenv", "XDG_DATA_HOME", "/workspace/sandbox/home/.local/share");

    if (request.env) {
      for (const [key, value] of Object.entries(request.env)) {
        if (typeof value === "string") {
          args.push("--setenv", key, value);
        }
      }
    }

    args.push("--chdir", sandboxCwd);

    args.push("--", request.cmd, ...request.args);

    return {
      cmd: "bwrap",
      args,
      cwd: this.rootDir,
    };
  }
}
