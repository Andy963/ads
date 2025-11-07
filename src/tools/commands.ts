import path from "node:path";

import { CommandLoader } from "../commands/loader.js";
import { CommandExecutor } from "../commands/executor.js";
import { detectWorkspace } from "../workspace/detector.js";
import { safeStringify } from "../utils/json.js";

export async function listCommands(params: { workspace_path?: string }): Promise<string> {
  try {
    const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
    const commands = CommandLoader.listCommands(workspace);
    return safeStringify({
      workspace,
      commands,
      count: commands.length,
    });
  } catch (error) {
    return safeStringify({ error: (error as Error).message });
  }
}

export async function getCommand(params: {
  command_name: string;
  workspace_path?: string;
}): Promise<string> {
  try {
    const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
    const command = CommandLoader.getCommand(workspace, params.command_name);
    if (!command) {
      return safeStringify({ error: `命令不存在: ${params.command_name}` });
    }

    return safeStringify({
      name: command.name,
      title: command.title,
      description: command.description,
      variables: command.variables,
      content: command.content,
      file_path: command.filePath,
    });
  } catch (error) {
    return safeStringify({ error: (error as Error).message });
  }
}

export async function executeCommand(params: {
  command_name: string;
  variables?: string;
  workspace_path?: string;
}): Promise<string> {
  try {
    const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
    const variables = params.variables ? JSON.parse(params.variables) : {};
    const content = CommandExecutor.executeForWorkspace(workspace, params.command_name, variables);
    return safeStringify({
      success: true,
      command: params.command_name,
      expanded_content: content,
    });
  } catch (error) {
    return safeStringify({ success: false, error: (error as Error).message });
  }
}

export async function validateCommand(params: {
  command_name: string;
  variables?: string;
  workspace_path?: string;
}): Promise<string> {
  try {
    const workspace = params.workspace_path ? path.resolve(params.workspace_path) : detectWorkspace();
    const variables = params.variables ? JSON.parse(params.variables) : {};
    const result = CommandExecutor.validateCommand(workspace, params.command_name, variables);
    return safeStringify(result);
  } catch (error) {
    return safeStringify({ valid: false, error: (error as Error).message });
  }
}
