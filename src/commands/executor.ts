import { CommandLoader, CommandDefinition } from "./loader.js";

export class CommandExecutor {
  private readonly loader: CommandLoader;

  constructor(loader: CommandLoader | string) {
    if (loader instanceof CommandLoader) {
      this.loader = loader;
    } else {
      this.loader = new CommandLoader(loader);
    }
  }

  execute(commandName: string, variables?: Record<string, string>): string | null {
    const command = this.loader.loadCommand(commandName);
    if (!command) {
      return null;
    }
    return substituteVariables(command, variables ?? {});
  }

  validate(commandName: string, variables?: Record<string, string>): Record<string, unknown> {
    const command = this.loader.loadCommand(commandName);
    if (!command) {
      return {
        valid: false,
        errors: [`Command not found: ${commandName}`],
        missing_variables: [],
      };
    }

    const vars = variables ?? {};
    const missing = command.variables.filter((variable) => !(variable in vars));

    return {
      valid: missing.length === 0,
      errors: missing.length === 0 ? [] : [`Missing variables: ${missing.join(", ")}`],
      missing_variables: missing,
      required_variables: command.variables,
    };
  }

  static executeForWorkspace(workspace: string, commandName: string, variables?: Record<string, string>): string {
    const loader = new CommandLoader(workspace);
    const command = loader.loadCommand(commandName);
    if (!command) {
      throw new Error(`Command not found: ${commandName}`);
    }

    const vars = variables ?? {};
    const missing = command.variables.filter((variable) => !(variable in vars));
    if (missing.length > 0) {
      throw new Error(`Missing required variables for command '${commandName}': ${missing.join(", ")}`);
    }

    return substituteVariables(command, vars);
  }

  static validateCommand(workspace: string, commandName: string, variables?: Record<string, string>): Record<string, unknown> {
    return new CommandExecutor(workspace).validate(commandName, variables);
  }
}

function substituteVariables(command: CommandDefinition, variables: Record<string, string>): string {
  let result = command.content;
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    result = result.replace(pattern, value);
  }
  return result;
}
