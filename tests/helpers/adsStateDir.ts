import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TempAdsStateDir = {
  stateDir: string;
  restore: () => void;
};

export function installTempAdsStateDir(prefix = "ads-state-"): TempAdsStateDir {
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
    },
  };
}

