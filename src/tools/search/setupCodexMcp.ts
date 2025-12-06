/**
 * Setup Tavily MCP for Codex CLI
 *
 * This script configures ~/.codex/config.toml to enable Tavily search
 * through the native MCP integration in Codex.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CODEX_CONFIG_DIR = path.join(os.homedir(), ".codex");
const CODEX_CONFIG_FILE = path.join(CODEX_CONFIG_DIR, "config.toml");

interface SetupResult {
  success: boolean;
  message: string;
  configPath?: string;
}

function ensureCodexConfigDir(): void {
  if (!fs.existsSync(CODEX_CONFIG_DIR)) {
    fs.mkdirSync(CODEX_CONFIG_DIR, { recursive: true });
  }
}

function readExistingConfig(): string {
  if (fs.existsSync(CODEX_CONFIG_FILE)) {
    return fs.readFileSync(CODEX_CONFIG_FILE, "utf-8");
  }
  return "";
}

function hasTavilyConfig(content: string): boolean {
  return content.includes("[mcp_servers.tavily]");
}

function buildTavilyConfig(apiKey: string, useRemote: boolean): string {
  if (useRemote) {
    return `
[mcp_servers.tavily]
url = "https://mcp.tavily.com/mcp/?tavilyApiKey=${apiKey}"
tool_timeout_sec = 30
`;
  }

  return `
[mcp_servers.tavily]
command = "npx"
args = ["-y", "tavily-mcp@latest"]
tool_timeout_sec = 30

[mcp_servers.tavily.env]
TAVILY_API_KEY = "${apiKey}"
`;
}

export function setupTavilyForCodex(options: {
  apiKey?: string;
  useRemote?: boolean;
  force?: boolean;
}): SetupResult {
  const apiKey = options.apiKey ?? process.env.TAVILY_API_KEY ?? process.env.TAVILY_API_KEYS?.split(",")[0]?.trim();

  if (!apiKey) {
    return {
      success: false,
      message: "Missing Tavily API key. Set TAVILY_API_KEY environment variable or pass --api-key option.",
    };
  }

  try {
    ensureCodexConfigDir();
    const existingConfig = readExistingConfig();

    if (hasTavilyConfig(existingConfig) && !options.force) {
      return {
        success: true,
        message: "Tavily MCP already configured in Codex. Use --force to overwrite.",
        configPath: CODEX_CONFIG_FILE,
      };
    }

    // Remove existing tavily config if present
    let newConfig = existingConfig;
    if (hasTavilyConfig(existingConfig)) {
      // Remove the [mcp_servers.tavily] section and its contents
      newConfig = existingConfig.replace(
        /\[mcp_servers\.tavily\][\s\S]*?(?=\n\[|$)/g,
        ""
      ).trim();
    }

    const tavilyConfig = buildTavilyConfig(apiKey, options.useRemote ?? false);
    newConfig = newConfig ? `${newConfig}\n${tavilyConfig}` : tavilyConfig.trim();

    fs.writeFileSync(CODEX_CONFIG_FILE, newConfig, "utf-8");

    const mode = options.useRemote ? "remote HTTP" : "local NPX";
    return {
      success: true,
      message: `Tavily MCP configured successfully (${mode}).\nConfig: ${CODEX_CONFIG_FILE}\n\nCodex will now have access to tavily_search and tavily_extract tools.`,
      configPath: CODEX_CONFIG_FILE,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to setup Tavily MCP: ${message}`,
    };
  }
}

export function checkTavilySetup(): {
  configured: boolean;
  mode?: "local" | "remote";
  configPath: string;
} {
  if (!fs.existsSync(CODEX_CONFIG_FILE)) {
    return { configured: false, configPath: CODEX_CONFIG_FILE };
  }

  const content = readExistingConfig();
  if (!hasTavilyConfig(content)) {
    return { configured: false, configPath: CODEX_CONFIG_FILE };
  }

  const mode = content.includes("url = \"https://mcp.tavily.com") ? "remote" : "local";
  return { configured: true, mode, configPath: CODEX_CONFIG_FILE };
}

export function removeTavilyConfig(): SetupResult {
  if (!fs.existsSync(CODEX_CONFIG_FILE)) {
    return {
      success: true,
      message: "No Codex config file found.",
    };
  }

  const existingConfig = readExistingConfig();
  if (!hasTavilyConfig(existingConfig)) {
    return {
      success: true,
      message: "Tavily MCP not configured.",
    };
  }

  const newConfig = existingConfig.replace(
    /\[mcp_servers\.tavily\][\s\S]*?(?=\n\[|$)/g,
    ""
  ).trim();

  fs.writeFileSync(CODEX_CONFIG_FILE, newConfig, "utf-8");

  return {
    success: true,
    message: "Tavily MCP configuration removed.",
    configPath: CODEX_CONFIG_FILE,
  };
}

// CLI entry point
if (process.argv[1]?.endsWith("setupCodexMcp.js") || process.argv[1]?.endsWith("setupCodexMcp.ts")) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "status" || command === "check") {
    const status = checkTavilySetup();
    if (status.configured) {
      console.log(`✅ Tavily MCP configured (${status.mode} mode)`);
      console.log(`   Config: ${status.configPath}`);
    } else {
      console.log("❌ Tavily MCP not configured");
      console.log(`   Config path: ${status.configPath}`);
      console.log("\nRun: npx ts-node src/tools/search/setupCodexMcp.ts setup");
    }
    process.exit(status.configured ? 0 : 1);
  }

  if (command === "remove") {
    const result = removeTavilyConfig();
    console.log(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
    process.exit(result.success ? 0 : 1);
  }

  if (command === "setup" || !command) {
    const useRemote = args.includes("--remote");
    const force = args.includes("--force");
    const apiKeyIndex = args.findIndex(a => a === "--api-key");
    const apiKey = apiKeyIndex !== -1 ? args[apiKeyIndex + 1] : undefined;

    const result = setupTavilyForCodex({ apiKey, useRemote, force });
    console.log(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
    process.exit(result.success ? 0 : 1);
  }

  console.log(`
Usage: npx ts-node src/tools/search/setupCodexMcp.ts <command>

Commands:
  setup [--remote] [--force] [--api-key KEY]  Configure Tavily MCP for Codex
  status                                       Check current configuration
  remove                                       Remove Tavily MCP configuration

Options:
  --remote     Use Tavily's remote MCP server (no local NPX required)
  --force      Overwrite existing configuration
  --api-key    Specify API key (defaults to TAVILY_API_KEY env var)
`);
}
