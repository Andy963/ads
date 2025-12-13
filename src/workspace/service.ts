import path from "node:path";

import {
  initializeWorkspace,
  detectWorkspace,
  getWorkspaceInfo,
  ensureDefaultTemplates,
} from "./detector.js";
import { safeStringify } from "../utils/json.js";
import { getErrorMessage } from "../utils/error.js";

export async function initWorkspace(params: { name?: string; workspace_path?: string }): Promise<string> {
  try {
    const workspace = initializeWorkspace(params.workspace_path, params.name);
    const result = {
      success: true,
      workspace: {
        path: workspace,
        name: params.name ?? path.basename(workspace),
      },
      created: {
        config: path.join(workspace, ".ads", "workspace.json"),
        rules_dir: path.join(workspace, ".ads", "rules"),
        specs_dir: path.join(workspace, "docs", "spec"),
        db: path.join(workspace, ".ads", "ads.db"),
      },
      message: `工作空间已初始化: ${workspace}`,
    };
    return safeStringify(result);
  } catch (error) {
    return safeStringify({ success: false, error: getErrorMessage(error) });
  }
}

export async function getCurrentWorkspace(): Promise<string> {
  try {
    const workspace = detectWorkspace();
    ensureDefaultTemplates(workspace);
    const info = getWorkspaceInfo(workspace);
    return safeStringify(info);
  } catch (error) {
    return safeStringify({ error: getErrorMessage(error) });
  }
}

export function syncWorkspaceTemplates(): void {
  ensureDefaultTemplates();
}
