import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TempAdsStateDir = {
  stateDir: string;
  restore: () => void;
};

const LOCK_FILE = path.join(os.tmpdir(), "ads-state-dir.lock");
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(SLEEP, 0, 0, ms);
}

function acquireLock(timeoutMs = 30_000): () => void {
  const startedAt = Date.now();
  while (true) {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
      return () => {
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          // ignore
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out acquiring ADS_STATE_DIR lock: ${LOCK_FILE}`);
      }
      sleep(25);
    }
  }
}

export function installTempAdsStateDir(prefix = "ads-state-"): TempAdsStateDir {
  const releaseLock = acquireLock();
  const original = process.env.ADS_STATE_DIR;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.ADS_STATE_DIR = stateDir;

  return {
    stateDir,
    restore: () => {
      if (original === undefined) {
        delete process.env.ADS_STATE_DIR;
      } else {
        process.env.ADS_STATE_DIR = original;
      }
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }

      releaseLock();
    },
  };
}

