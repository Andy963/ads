import { promises as fs } from "node:fs";
import path from "node:path";

import { detectWorkspace } from "../workspace/detector.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../workspace/adsPaths.js";
import type { IntakeState } from "./types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("IntakeStorage");

const STATE_FILENAME = "intake-state.json";

function getStateFilePath(workspacePath?: string): string {
  const workspace = workspacePath ? path.resolve(workspacePath) : detectWorkspace();
  migrateLegacyWorkspaceAdsIfNeeded(workspace);
  return resolveWorkspaceStatePath(workspace, STATE_FILENAME);
}

export async function loadIntakeState(workspacePath?: string): Promise<IntakeState | null> {
  const filePath = getStateFilePath(workspacePath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as IntakeState;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    parsed.pending = Array.isArray(parsed.pending) ? parsed.pending : [];
    parsed.fields = parsed.fields ?? {};
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    logger.warn("读取 intake 状态失败", error);
    return null;
  }
}

export async function saveIntakeState(state: IntakeState, workspacePath?: string): Promise<void> {
  const filePath = getStateFilePath(workspacePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload: IntakeState = {
    ...state,
    fields: state.fields ?? {},
    pending: state.pending ?? [],
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

export async function clearIntakeState(workspacePath?: string): Promise<void> {
  const filePath = getStateFilePath(workspacePath);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("清理 intake 状态失败", error);
    }
  }
}
