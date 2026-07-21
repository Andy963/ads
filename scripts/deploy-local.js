#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(scriptPath), "..");
const home = os.homedir();
const runtimeRoot = path.join(home, ".local", "share", "ads-runtime");
const releasesDir = path.join(runtimeRoot, "releases");
const currentLink = path.join(runtimeRoot, "current");
const projectsRoot = path.join(home, "repos");
const stateDir = path.join(home, ".local", "state", "ads");
const envPath = path.join(sourceRoot, ".env");
const serviceDir = path.join(home, ".config", "systemd", "user");
const webServiceName = "ads-web";
const webServicePath = path.join(serviceDir, "ads-web.service");
const telegramServiceName = "ads-tg";
const telegramServicePath = path.join(serviceDir, "ads-tg.service");
const nodeBinDir = path.join(home, ".local", "nodejs", "bin");
const preferredNode = path.join(nodeBinDir, "node");
const preferredNpm = path.join(nodeBinDir, "npm");
const nodeBin = fs.existsSync(preferredNode) ? preferredNode : process.execPath;
const npmBin = fs.existsSync(preferredNpm) ? preferredNpm : "npm";
const toolEnv = {
  ...process.env,
  PATH: [nodeBinDir, process.env.PATH].filter(Boolean).join(path.delimiter),
};
const releaseName = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${process.pid}`;
const stagingDir = path.join(releasesDir, `.staging-${releaseName}`);
const releaseDir = path.join(releasesDir, releaseName);
const detachedDeployFlag = "ADS_DEPLOY_DETACHED";

function formatCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function run(command, args, options = {}) {
  console.log(`$ ${formatCommand(command, args)}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture
      ? `\n${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.trimEnd()
      : "";
    throw new Error(`Command failed (${result.status}): ${formatCommand(command, args)}${details}`);
  }
  return String(result.stdout ?? "").trim();
}

function isRunningInsideService(serviceName) {
  try {
    const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
    return cgroup.split("\n").some((line) => line.includes(`/${serviceName}.service`));
  } catch {
    return false;
  }
}

function delegateDeployment() {
  const unitName = `ads-deploy-${releaseName}`;
  run("systemd-run", [
    "--user",
    `--unit=${unitName}`,
    "--collect",
    "--property=Type=exec",
    `--working-directory=${sourceRoot}`,
    `--setenv=${detachedDeployFlag}=1`,
    `--setenv=HOME=${home}`,
    `--setenv=PATH=${toolEnv.PATH}`,
    nodeBin,
    scriptPath,
  ]);
  console.log(`Deployment delegated to ${unitName}.service`);
  console.log(`Follow progress: journalctl --user -fu ${unitName}.service`);
}

function serviceIsActive(serviceName) {
  const result = spawnSync("systemctl", ["--user", "is-active", "--quiet", serviceName], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function serviceIsEnabled(serviceName) {
  const result = spawnSync("systemctl", ["--user", "is-enabled", "--quiet", serviceName], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function assertServiceStable(serviceName) {
  sleep(2000);
  if (!serviceIsActive(serviceName)) {
    throw new Error(`${serviceName} did not remain active after restart`);
  }
}

function copyFile(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing deployment input: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing deployment input: ${source}`);
  }
  fs.cpSync(source, destination, { recursive: true });
}

function writeAtomic(filePath, content, mode) {
  const temporaryPath = `${filePath}.next-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode });
  fs.renameSync(temporaryPath, filePath);
}

function switchCurrent(target) {
  const temporaryLink = `${currentLink}.next-${process.pid}`;
  fs.rmSync(temporaryLink, { force: true });
  fs.symlinkSync(target, temporaryLink);
  fs.renameSync(temporaryLink, currentLink);
}

function removeCurrentLink() {
  try {
    if (fs.lstatSync(currentLink).isSymbolicLink()) {
      fs.unlinkSync(currentLink);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function readCurrentTarget() {
  try {
    const stat = fs.lstatSync(currentLink);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${currentLink} exists but is not a symbolic link`);
    }
    return path.resolve(path.dirname(currentLink), fs.readlinkSync(currentLink));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function buildServiceUnit(options) {
  const sourceRelativeToProjects = path.relative(projectsRoot, sourceRoot);
  const sourceIsInsideProjects =
    sourceRelativeToProjects === "" ||
    (!sourceRelativeToProjects.startsWith(`..${path.sep}`) && sourceRelativeToProjects !== ".." && !path.isAbsolute(sourceRelativeToProjects));
  const allowedDirs = sourceIsInsideProjects ? projectsRoot : [projectsRoot, sourceRoot].join(",");
  const servicePathValue = [
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "nodejs", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");

  return `[Unit]
Description=${options.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${projectsRoot}
Environment=HOME=${home}
Environment=ADS_ENV_PATH=${envPath}
Environment=ADS_STATE_DIR=${stateDir}
Environment=ALLOWED_DIRS=${allowedDirs}
Environment=PATH=${servicePathValue}
ExecStart=${nodeBin} ${path.join(currentLink, "dist", "server", "cli.js")} ${options.command}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`;
}

function buildWebServiceUnit() {
  return buildServiceUnit({
    description: "ADS Web Console",
    command: "web",
  });
}

function buildTelegramServiceUnit() {
  return buildServiceUnit({
    description: "ADS Telegram Bot",
    command: "telegram",
  });
}

function prepareState() {
  if (!fs.existsSync(stateDir)) {
    const sourceState = path.join(sourceRoot, ".ads");
    if (fs.existsSync(sourceState)) {
      fs.mkdirSync(path.dirname(stateDir), { recursive: true });
      fs.cpSync(sourceState, stateDir, { recursive: true });
      console.log(`Copied existing ADS state to ${stateDir}`);
    } else {
      fs.mkdirSync(stateDir, { recursive: true });
    }
  }
}

function assembleRelease() {
  fs.mkdirSync(releasesDir, { recursive: true });
  fs.mkdirSync(stagingDir);
  copyDirectory(path.join(sourceRoot, "dist"), path.join(stagingDir, "dist"));
  copyDirectory(path.join(sourceRoot, "dist", "templates"), path.join(stagingDir, "templates"));
  copyDirectory(path.join(sourceRoot, "scripts"), path.join(stagingDir, "scripts"));
  for (const file of ["package.json", "package-lock.json", "tsconfig.build.json"]) {
    copyFile(path.join(sourceRoot, file), path.join(stagingDir, file));
  }

  run(npmBin, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: stagingDir,
    env: toolEnv,
  });
  run(nodeBin, [path.join(stagingDir, "dist", "server", "cli.js"), "version"], {
    cwd: stagingDir,
    env: {
      ...toolEnv,
      ADS_ENV_PATH: envPath,
      ADS_STATE_DIR: stateDir,
    },
  });

  fs.renameSync(stagingDir, releaseDir);
}

const hostedByAdsService = [webServiceName, telegramServiceName].some(isRunningInsideService);
if (process.env[detachedDeployFlag] !== "1" && hostedByAdsService) {
  delegateDeployment();
  process.exit(0);
}

const previousCurrent = readCurrentTarget();
const services = [
  {
    name: webServiceName,
    filePath: webServicePath,
    unit: buildWebServiceUnit(),
  },
  {
    name: telegramServiceName,
    filePath: telegramServicePath,
    unit: buildTelegramServiceUnit(),
  },
].map((service) => ({
  ...service,
  previousUnit: fs.existsSync(service.filePath) ? fs.readFileSync(service.filePath, "utf8") : null,
  wasActive: serviceIsActive(service.name),
  wasEnabled: serviceIsEnabled(service.name),
}));
let switched = false;
let servicesStopped = false;

try {
  run(npmBin, ["run", "build"], { cwd: sourceRoot, env: toolEnv });
  assembleRelease();

  for (const service of services) {
    if (service.wasActive) {
      run("systemctl", ["--user", "stop", service.name]);
    }
  }
  servicesStopped = true;

  prepareState();
  for (const service of services) {
    writeAtomic(service.filePath, service.unit, 0o644);
  }
  switchCurrent(releaseDir);
  switched = true;

  run("systemctl", ["--user", "daemon-reload"]);
  for (const service of services) {
    run("systemctl", ["--user", "enable", service.name]);
    run("systemctl", ["--user", "restart", service.name]);
  }
  for (const service of services) {
    assertServiceStable(service.name);
  }

  console.log(`ADS deployed to ${releaseDir}`);
  console.log(`Current runtime: ${currentLink}`);
} catch (error) {
  console.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);

  if (servicesStopped || switched) {
    for (const service of services) {
      spawnSync("systemctl", ["--user", "stop", service.name], { stdio: "ignore" });
    }
  }

  if (switched) {
    if (previousCurrent) switchCurrent(previousCurrent);
    else removeCurrentLink();
  }

  for (const service of services) {
    if (service.previousUnit === null) {
      fs.rmSync(service.filePath, { force: true });
    } else {
      writeAtomic(service.filePath, service.previousUnit, 0o644);
    }
  }

  try {
    run("systemctl", ["--user", "daemon-reload"]);
    for (const service of services) {
      if (service.previousUnit !== null) {
        if (service.wasEnabled) {
          run("systemctl", ["--user", "enable", service.name]);
        } else {
          run("systemctl", ["--user", "disable", service.name]);
        }
      }
      if (service.previousUnit !== null && service.wasActive) {
        run("systemctl", ["--user", "restart", service.name]);
      }
    }
  } catch (rollbackError) {
    console.error(`Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
  }

  process.exitCode = 1;
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
