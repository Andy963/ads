#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyChangedFiles } from "./lib/deploy-scope.js";

const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(scriptPath), "..");
const telegramConnectorRoot = path.join(sourceRoot, "connectors", "telegram");
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
// Keep the existing unit name for compatibility; the process is now standalone.
const telegramServiceName = "ads-tg";
const telegramServicePath = path.join(serviceDir, "ads-tg.service");
const nodeBin = process.execPath;
const nodeBinDir = path.dirname(nodeBin);
const preferredNpm = path.join(nodeBinDir, "npm");
const npmBin = fs.existsSync(preferredNpm) ? preferredNpm : "npm";
const toolEnv = {
  ...process.env,
  PATH: [nodeBinDir, path.join(home, ".local", "bin"), process.env.PATH].filter(Boolean).join(path.delimiter),
};
const releaseName = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${process.pid}`;
const stagingDir = path.join(releasesDir, `.staging-${releaseName}`);
const releaseDir = path.join(releasesDir, releaseName);
const detachedDeployFlag = "ADS_DEPLOY_DETACHED";
const forceRestartEnvFlag = "ADS_FORCE_RESTART";
const releaseMetadataFileName = ".ads-release.json";
const cliArgs = process.argv.slice(2);
const forceRestart = cliArgs.includes("--force-restart") || process.env[forceRestartEnvFlag] === "1";

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
  const setenvArgs = [
    `--setenv=${detachedDeployFlag}=1`,
    `--setenv=HOME=${home}`,
    `--setenv=PATH=${toolEnv.PATH}`,
  ];
  if (process.env[forceRestartEnvFlag]) {
    setenvArgs.push(`--setenv=${forceRestartEnvFlag}=${process.env[forceRestartEnvFlag]}`);
  }
  run("systemd-run", [
    "--user",
    `--unit=${unitName}`,
    "--collect",
    "--property=Type=exec",
    `--working-directory=${sourceRoot}`,
    ...setenvArgs,
    nodeBin,
    scriptPath,
    ...cliArgs,
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

function tryRunCapture(command, args, options = {}) {
  try {
    return run(command, args, { ...options, capture: true });
  } catch {
    return null;
  }
}

function readSourceCommit() {
  return tryRunCapture("git", ["rev-parse", "HEAD"], { cwd: sourceRoot });
}

function readDeployedCommit(releasePath) {
  if (!releasePath) return null;
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(releasePath, releaseMetadataFileName), "utf8"));
    return typeof metadata?.commit === "string" && metadata.commit.length > 0 ? metadata.commit : null;
  } catch {
    return null;
  }
}

function writeReleaseMetadata(targetDir) {
  const metadata = {
    commit: readSourceCommit(),
    deployedAt: new Date().toISOString(),
  };
  writeAtomic(path.join(targetDir, releaseMetadataFileName), `${JSON.stringify(metadata, null, 2)}\n`, 0o644);
}

// Returns the deduplicated list of files that differ between the deployed
// commit and the current working tree (tracked modifications plus untracked,
// non-ignored files), or null when the diff baseline cannot be established.
function listChangedFilesSince(baseCommit) {
  const commitExists = tryRunCapture("git", ["cat-file", "-e", `${baseCommit}^{commit}`], { cwd: sourceRoot });
  if (commitExists === null) return null;
  const tracked = tryRunCapture("git", ["diff", "--no-renames", "--name-only", baseCommit], { cwd: sourceRoot });
  const untracked = tryRunCapture("git", ["ls-files", "--others", "--exclude-standard"], { cwd: sourceRoot });
  if (tracked === null || untracked === null) return null;
  const files = new Set();
  for (const line of [...tracked.split("\n"), ...untracked.split("\n")]) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }
  return [...files];
}

function buildOutputsReadyForClientOnly() {
  if (!fs.existsSync(path.join(sourceRoot, "dist", "server", "cli.js"))) return false;
  if (fs.existsSync(telegramConnectorRoot) && !fs.existsSync(path.join(telegramConnectorRoot, "dist"))) return false;
  return true;
}

// Any uncertainty resolves to "full" so a missed backend change can never ship
// as a zero-downtime static update.
function decideDeployMode({ previousCurrent, webServiceActive }) {
  if (forceRestart) {
    return { mode: "full", reason: `restart forced via --force-restart or ${forceRestartEnvFlag}=1` };
  }
  const deployedCommit = readDeployedCommit(previousCurrent);
  if (!deployedCommit) {
    return { mode: "full", reason: "no deployed release metadata (first deploy or legacy release)" };
  }
  if (!webServiceActive) {
    return { mode: "full", reason: `${webServiceName} is not active; a full deploy is required to bring services up` };
  }
  if (!buildOutputsReadyForClientOnly()) {
    return { mode: "full", reason: "build outputs are incomplete; a full build is required" };
  }
  const changedFiles = listChangedFilesSince(deployedCommit);
  if (changedFiles === null) {
    return { mode: "full", reason: `could not diff against deployed commit ${deployedCommit}` };
  }
  if (classifyChangedFiles(changedFiles) === "client-only") {
    return {
      mode: "client-only",
      reason: `only client/docs changes since ${deployedCommit.slice(0, 12)} (${changedFiles.length} file(s))`,
    };
  }
  return { mode: "full", reason: `backend-affecting changes since ${deployedCommit.slice(0, 12)}` };
}

function buildServiceUnit(options) {
  const sourceRelativeToProjects = path.relative(projectsRoot, sourceRoot);
  const sourceIsInsideProjects =
    sourceRelativeToProjects === "" ||
    (!sourceRelativeToProjects.startsWith(`..${path.sep}`) && sourceRelativeToProjects !== ".." && !path.isAbsolute(sourceRelativeToProjects));
  const allowedDirs = sourceIsInsideProjects ? projectsRoot : [projectsRoot, sourceRoot].join(",");
  const servicePathValue = [
    nodeBinDir,
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean).join(":");
  const environmentFile = options.environmentFile ? `EnvironmentFile=-${options.environmentFile}\n` : "";

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
${environmentFile}ExecStart=${nodeBin} ${options.entrypoint} ${options.command}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`;
}

function buildWebServiceUnit() {
  return buildServiceUnit({
    description: "ADS Web Console",
    entrypoint: path.join(currentLink, "dist", "server", "cli.js"),
    command: "web",
  });
}

function buildTelegramServiceUnit() {
  return buildServiceUnit({
    description: "ADS Telegram Connector",
    entrypoint: path.join(currentLink, "connectors", "telegram", "bin", "ads-telegram.js"),
    command: "start",
    environmentFile: envPath,
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
  copyDirectory(path.join(sourceRoot, "scripts"), path.join(stagingDir, "scripts"));
  for (const file of ["package.json", "package-lock.json", "tsconfig.build.json"]) {
    copyFile(path.join(sourceRoot, file), path.join(stagingDir, file));
  }

  if (fs.existsSync(telegramConnectorRoot)) {
    const connectorStagingRoot = path.join(stagingDir, "connectors", "telegram");
    copyDirectory(path.join(telegramConnectorRoot, "dist"), path.join(connectorStagingRoot, "dist"));
    for (const file of ["bin/ads-telegram.js", "package.json", "package-lock.json"]) {
      copyFile(path.join(telegramConnectorRoot, file), path.join(connectorStagingRoot, file));
    }
  }

  run(npmBin, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: stagingDir,
    env: toolEnv,
  });

  if (fs.existsSync(telegramConnectorRoot)) {
    run(npmBin, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: path.join(stagingDir, "connectors", "telegram"),
      env: toolEnv,
    });
  }
  run(nodeBin, [path.join(stagingDir, "dist", "server", "cli.js"), "version"], {
    cwd: stagingDir,
    env: {
      ...toolEnv,
      ADS_ENV_PATH: envPath,
      ADS_STATE_DIR: stateDir,
    },
  });

  writeReleaseMetadata(stagingDir);
  fs.renameSync(stagingDir, releaseDir);
}

const hostedByAdsService = [webServiceName, telegramServiceName].some(isRunningInsideService);
if (process.env[detachedDeployFlag] !== "1" && hostedByAdsService) {
  delegateDeployment();
  process.exit(0);
}

const previousCurrent = readCurrentTarget();
const serviceDefinitions = [
  {
    name: webServiceName,
    filePath: webServicePath,
    unit: buildWebServiceUnit(),
    optional: false,
  },
];
const shouldManageTelegramService =
  fs.existsSync(telegramServicePath) ||
  serviceIsActive(telegramServiceName) ||
  serviceIsEnabled(telegramServiceName);
if (shouldManageTelegramService) {
  serviceDefinitions.push({
    name: telegramServiceName,
    filePath: telegramServicePath,
    unit: buildTelegramServiceUnit(),
    optional: true,
  });
}
const services = serviceDefinitions.map((service) => ({
  ...service,
  previousUnit: fs.existsSync(service.filePath) ? fs.readFileSync(service.filePath, "utf8") : null,
  wasActive: serviceIsActive(service.name),
  wasEnabled: serviceIsEnabled(service.name),
}));
let switched = false;
let servicesStopped = false;

const webServiceState = services.find((service) => service.name === webServiceName);
const deployDecision = decideDeployMode({
  previousCurrent,
  webServiceActive: webServiceState ? webServiceState.wasActive : false,
});
console.log(`[Deploy] Mode: ${deployDecision.mode} (${deployDecision.reason})`);

try {
  if (deployDecision.mode === "client-only") {
    run(npmBin, ["run", "build:web"], { cwd: sourceRoot, env: toolEnv });
    assembleRelease();

    prepareState();
    switchCurrent(releaseDir);
    switched = true;

    console.log("[Deploy] Client-only changes detected. Static assets updated with zero downtime (backend restart skipped).");
    console.log(`ADS deployed to ${releaseDir}`);
    console.log(`Current runtime: ${currentLink}`);
  } else {
    run(npmBin, ["run", "build"], { cwd: sourceRoot, env: toolEnv });
    if (fs.existsSync(telegramConnectorRoot)) {
      run(npmBin, ["run", "build"], { cwd: telegramConnectorRoot, env: toolEnv });
    }
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
      try {
        run("systemctl", ["--user", "enable", service.name]);
        run("systemctl", ["--user", "restart", service.name]);
      } catch (error) {
        if (!service.optional) throw error;
        console.error(`Optional service ${service.name} could not be started: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const service of services) {
      try {
        assertServiceStable(service.name);
      } catch (error) {
        if (!service.optional) throw error;
        console.error(`Optional service ${service.name} is not stable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(`ADS deployed to ${releaseDir}`);
    console.log(`Current runtime: ${currentLink}`);
  }
} catch (error) {
  console.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);

  if (deployDecision.mode === "client-only") {
    // Services were never stopped or reconfigured; restoring the symlink is
    // the only rollback needed.
    if (switched) {
      if (previousCurrent) switchCurrent(previousCurrent);
      else removeCurrentLink();
    }
  } else {
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
  }

  process.exitCode = 1;
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
