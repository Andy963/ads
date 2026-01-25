import fs from "node:fs";
import path from "node:path";

import yaml from "yaml";
import { createLogger } from "../utils/logger.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../workspace/adsPaths.js";

const logger = createLogger("CommandLoader");

export interface CommandDefinition {
  name: string;
  title: string;
  description: string;
  content: string;
  variables: string[];
  filePath: string;
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: raw };
  }

  const parts = trimmed.split("---");
  if (parts.length < 3) {
    return { frontmatter: {}, body: raw };
  }

  const [, frontmatterText, ...rest] = parts;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = yaml.parse(frontmatterText) ?? {};
  } catch {
    parsed = {};
  }

  const body = rest.join("---").trimStart();
  return { frontmatter: parsed, body };
}

function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function extractDescription(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const description: string[] = [];
  let afterTitle = false;

  for (const line of lines) {
    if (line.startsWith("# ")) {
      afterTitle = true;
      continue;
    }
    if (!afterTitle) {
      continue;
    }
    if (!line.trim()) {
      if (description.length > 0) {
        break;
      }
      continue;
    }
    if (line.startsWith("---")) {
      break;
    }
    if (!line.startsWith("**") && !line.startsWith("-")) {
      description.push(line.trim());
    }
  }

  return description.length > 0 ? description.join(" ") : null;
}

function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{(\w+)\}\}/g) ?? [];
  const unique: string[] = [];
  for (const match of matches) {
    const name = match.replace(/[{}]/g, "");
    if (!unique.includes(name)) {
      unique.push(name);
    }
  }
  return unique;
}

function parseCommandFile(filePath: string): CommandDefinition {
  const rawContent = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(rawContent);
  const title = (frontmatter.title as string) ?? extractTitle(body) ?? path.basename(filePath, ".md");
  const description = (frontmatter.description as string) ?? extractDescription(body) ?? title;
  const variables = Array.isArray(frontmatter.variables)
    ? (frontmatter.variables as string[])
    : extractVariables(body);

  const name = (frontmatter.name as string) ?? path.basename(filePath, ".md");

  return {
    name,
    title,
    description,
    variables: Array.from(new Set(variables)),
    content: body,
    filePath,
  };
}

export class CommandLoader {
  constructor(private readonly workspace: string) {}

  static loadFromWorkspace(workspace: string): Record<string, CommandDefinition> {
    const loader = new CommandLoader(workspace);
    return loader.loadFromWorkspace();
  }

  loadFromWorkspace(): Record<string, CommandDefinition> {
    const commands: Record<string, CommandDefinition> = {};
    migrateLegacyWorkspaceAdsIfNeeded(this.workspace);
    const candidateDirs = [
      resolveWorkspaceStatePath(this.workspace, "commands"),
      this.workspace,
    ];

    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        continue;
      }

      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".md")) {
          continue;
        }

        const fullPath = path.join(dir, file);
        try {
          const command = parseCommandFile(fullPath);
          commands[command.name] = command;
        } catch (error) {
          logger.warn(`Failed to load command ${fullPath}: ${(error as Error).message}`, error);
        }
      }
    }

    return commands;
  }

  listCommands(): Array<{ name: string; title: string; description: string; variables: string[] }> {
    const loaded = this.loadFromWorkspace();
    return Object.values(loaded).map((command) => ({
      name: command.name,
      title: command.title,
      description: command.description,
      variables: command.variables,
    }));
  }

  loadCommand(name: string): CommandDefinition | null {
    const commands = this.loadFromWorkspace();
    return commands[name] ?? null;
  }

  static listCommands(workspace: string): Array<{ name: string; title: string; description: string; variables: string[] }> {
    return new CommandLoader(workspace).listCommands();
  }

  static getCommand(workspace: string, commandName: string): CommandDefinition | null {
    return new CommandLoader(workspace).loadCommand(commandName);
  }
}
