import path from "node:path";

import {
  initializeWorkspace,
  detectWorkspace,
  getWorkspaceInfo,
} from "../workspace/detector.js";
import { safeStringify } from "../utils/json.js";

export async function initWorkspace(params: { name?: string }): Promise<string> {
  try {
    const workspace = initializeWorkspace(undefined, params.name);
    const result = {
      success: true,
      workspace: {
        path: workspace,
        name: params.name ?? path.basename(workspace),
      },
      created: {
        config: path.join(workspace, ".ads", "workspace.json"),
        rules_dir: path.join(workspace, ".ads", "rules"),
        specs_dir: path.join(workspace, "docs", "specs"),
        db: path.join(workspace, ".ads", "ads.db"),
      },
      message: `工作空间已初始化: ${workspace}`,
    };
    return safeStringify(result);
  } catch (error) {
    return safeStringify({ success: false, error: (error as Error).message });
  }
}

export async function getCurrentWorkspace(): Promise<string> {
  try {
    const workspace = detectWorkspace();
    const info = getWorkspaceInfo(workspace);
    return safeStringify(info);
  } catch (error) {
    return safeStringify({ error: (error as Error).message });
  }
}
