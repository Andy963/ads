
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import fs from "node:fs";
import path from "node:path";
import * as readline from "readline";
import { EOL } from "os";
import { Codex } from "@openai/codex-sdk";
import {
  parseSlashCommand,
  resolveCodexConfig,
  type CodexResolvedConfig,
} from "./src/codexConfig.js";

const useLegacyClient = process.env.ADS_CLIENT_LEGACY === "1";

if (!useLegacyClient) {
  console.log("[ads-client] 该工具已弃用，正在转发到新的 'ads' CLI。如需旧版，请设置 ADS_CLIENT_LEGACY=1。");
  await import("./src/cli/index.js");
}

// 定义工具的配置
interface ToolConfig {
  name: string;
  command: string;
  args: string[];
}

interface PendingRequest {
  resolve: (response: any) => void;
  reject: (error: any) => void;
}

// Harness类，用于管理和与子进程通信
class McpHarness {
  private process: ChildProcessWithoutNullStreams | null = null;
  private requestCounter = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private buffer = "";

  constructor(private toolConfig: ToolConfig) {}

  // 启动子进程并设置监听器
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[Harness] Starting tool: ${this.toolConfig.name}`);
      this.process = spawn(this.toolConfig.command, this.toolConfig.args, {
        stdio: ["pipe", "pipe", "pipe"], // 使用管道进行IPC
      });

      this.process.on("spawn", () => {
        console.log(`[Harness] Tool process started with PID: ${this.process?.pid}`);
        resolve();
      });

      this.process.on("error", (err) => {
        console.error("[Harness] Failed to start tool process.", err);
        reject(err);
      });

      this.process.stderr.on("data", (data: Buffer) => {
        console.error(`[Tool STDERR] ${data.toString()}`);
      });

      this.process.stdout.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.process.on("exit", (code) => {
        console.log(`[Harness] Tool process exited with code ${code}`);
        this.process = null;
      });
    });
  }

  // 处理从stdout收到的数据，解析完整的JSON消息
  private processBuffer() {
    let eolIndex;
    while ((eolIndex = this.buffer.indexOf(EOL)) >= 0) {
      const message = this.buffer.slice(0, eolIndex);
      this.buffer = this.buffer.slice(eolIndex + EOL.length);

      if (message) {
        try {
          const payload = JSON.parse(message);
          if (payload.id !== undefined && this.pendingRequests.has(payload.id)) {
            const pending = this.pendingRequests.get(payload.id)!;
            this.pendingRequests.delete(payload.id);
            if ("error" in payload) {
              pending.reject(payload.error);
            } else {
              pending.resolve(payload.result);
            }
          } else if (payload.method) {
            console.log("[Tool Notification]", JSON.stringify(payload, null, 2));
          } else {
            console.warn("[Harness] Received untracked message:", JSON.stringify(payload));
          }
        } catch (e) {
          console.error("[Harness] Error parsing JSON response from tool:", e);
        }
      }
    }
  }

  private sendRequest(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.process) {
      return Promise.reject(new Error("Tool process is not running."));
    }

    const requestId = this.requestCounter++;
    const request = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      const message = JSON.stringify(request) + EOL;
      this.process!.stdin.write(message);
      // MCP 调用日志已禁用，保持输出清爽
    });
  }

  public initialize(): Promise<any> {
    return this.sendRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "ads-harness",
        version: "0.1.0",
      },
    });
  }

  public listTools(): Promise<any> {
    return this.sendRequest("tools/list");
  }

  // 调用工具的MCP方法
  public call(
    toolName: string,
    params: Record<string, unknown> = {}
  ): Promise<any> {
    return this.sendRequest("tools/call", {
      name: toolName,
      arguments: params,
    });
  }

  // 停止子进程
  public stop() {
    if (this.process) {
      console.log("[Harness] Stopping tool process.");
      this.process.kill();
    }
  }
}

class CodexChatSession {
  private readonly codex: Codex;
  private thread: ReturnType<Codex["startThread"]> | null = null;

  constructor(private readonly config: CodexResolvedConfig) {
    this.codex = new Codex({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
  }

  reset() {
    this.thread = null;
  }

  async send(prompt: string) {
    if (!this.thread) {
      this.thread = this.codex.startThread({
        skipGitRepoCheck: true,
      });
    }
    return this.thread.run(prompt);
  }
}

// 主函数
async function main() {
  // 1. 编译你的ads-js项目 (确保dist/server.js存在)
  console.log("Compiling ads-js first...");
  const buildProcess = spawn("npm", ["run", "build"]);
  await new Promise(resolve => buildProcess.on('close', resolve));
  console.log("Compilation complete.");

  // 2. 配置Harness来运行你的ads-js服务器
  const adsTool = new McpHarness({
    name: "ads-js",
    command: "node",
    args: ["dist/server.js"],
  });

  await adsTool.start();
  await adsTool.initialize();
  try {
    const toolList = await adsTool.listTools();
    const count = Array.isArray(toolList?.tools) ? toolList.tools.length : 0;
    console.log(`[ADS] ${count} tools available.`);
  } catch (err) {
    console.error("[ADS] Failed to list tools:", err);
  }

  await ensureWorkspace(adsTool);

  let codexConfig: CodexResolvedConfig | null = null;
  let codexChat: CodexChatSession | null = null;
  try {
    codexConfig = resolveCodexConfig();
    codexChat = new CodexChatSession(codexConfig);
    console.log("[Codex] Ready.");
  } catch (err) {
    console.warn(
      "[Codex] Unable to resolve Codex credentials. Chat functionality disabled.",
      (err as Error).message
    );
  }

  // 3. 创建一个命令行读取器 (REPL) 来模拟Agent的UI
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "AGENT> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      rl.prompt();
      return;
    }

    let effectiveLine = trimmed;
    const adsMatch = trimmed.match(/^ads(?:[.\s]+)([a-zA-Z0-9._-]+)(.*)$/);
    if (adsMatch) {
      const remainder = adsMatch[2]?.trim();
      effectiveLine = `/ads.${adsMatch[1]}${remainder ? ` ${remainder}` : ""}`;
      console.log(`[ADS] Interpreting input as '${effectiveLine}'`);
    }

    const parts = effectiveLine.split(/\s+/);
    const slash = parseSlashCommand(effectiveLine);

    if (effectiveLine === "/exit") {
      adsTool.stop();
      rl.close();
      return;
    }

    if (effectiveLine === "/reset") {
      codexChat?.reset();
      console.log("[Codex] Conversation thread reset.");
      rl.prompt();
      return;
    }
    
    if (slash && slash.command.startsWith("ads.")) {
      // 调用 ADS 工具
      const rawArgs = parts.slice(1);
      const params: Record<string, string> = {};
      const positional: string[] = [];

      for (const token of rawArgs) {
        const match = token.match(/^--([^=]+)=(.+)$/);
        if (match) {
          params[match[1]] = match[2];
        } else {
          positional.push(token.replace(/^['"]|['"]$/g, ""));
        }
      }

      // ads.new: template_id + title
      if (slash.command === "ads.new") {
        if (!params.template_id && positional.length > 0) {
          params.template_id = positional.shift()!;
        }
        if (!params.title && positional.length > 0) {
          params.title = positional.join(" ");
        }
      }

      // ads.checkout: workflow_identifier
      if (slash.command === "ads.checkout") {
        if (!params.workflow_identifier && positional.length > 0) {
          params.workflow_identifier = positional.shift()!;
        }
      }

      // ads.branch: 支持 -d 删除, -D 强制删除
      if (slash.command === "ads.branch") {
        let deleteMode: "none" | "soft" | "hard" = "none";
        let workflowArg: string | undefined;

        for (let i = 0; i < rawArgs.length; i += 1) {
          const token = rawArgs[i];

          if (token === "-d" || token === "--delete-context") {
            deleteMode = "soft";
            workflowArg = rawArgs.slice(i + 1).join(" ") || workflowArg;
            break;
          }

          if (token === "-D" || token === "--delete" || token === "--force-delete") {
            deleteMode = "hard";
            workflowArg = rawArgs.slice(i + 1).join(" ") || workflowArg;
            break;
          }

          if (token.startsWith("--delete=")) {
            deleteMode = "hard";
            workflowArg = token.slice("--delete=".length) || workflowArg;
            if (!workflowArg && i + 1 < rawArgs.length) {
              workflowArg = rawArgs[i + 1];
            }
            break;
          }

          if (token.startsWith("--delete-context=")) {
            deleteMode = "soft";
            workflowArg = token.slice("--delete-context=".length) || workflowArg;
            if (!workflowArg && i + 1 < rawArgs.length) {
              workflowArg = rawArgs[i + 1];
            }
            break;
          }
        }

        if (deleteMode === "soft") {
          params.operation = "delete";
        } else if (deleteMode === "hard") {
          params.operation = "force_delete";
        } else {
          params.operation = "list";
        }

        if (deleteMode !== "none" && workflowArg) {
          params.workflow = workflowArg.trim().replace(/^['"]|['"]$/g, "");
        }
      }

      // ads.add: step_name + content
      if (slash.command === "ads.add") {
        if (!params.step_name && positional.length > 0) {
          params.step_name = positional.shift()!;
        }
        if (!params.content && positional.length > 0) {
          params.content = positional.join(" ");
        }
      }

      // ads.commit: step_name
      if (slash.command === "ads.commit") {
        if (!params.step_name && positional.length > 0) {
          params.step_name = positional.shift()!;
        }
      }

      // ads.get: step_name
      if (slash.command === "ads.get") {
        if (!params.step_name && positional.length > 0) {
          params.step_name = positional.shift()!;
        }
      }

      try {
        const result = await adsTool.call(slash.command, params);
        printToolResult(slash.command, result);
      } catch (error) {
        // 友好的错误信息显示
        if (error && typeof error === "object") {
          const err = error as any;

          // 处理 MCP 错误
          if (err.code === -32602) {
            const msg = err.message || "";

            // 工具不存在
            if (msg.includes("not found")) {
              console.error(`❌ 工具不存在: ${slash.command}`);
              console.error(`💡 提示: 检查拼写或使用 /ads.status 查看可用命令`);
            }
            // 参数错误
            else if (msg.includes("Invalid arguments")) {
              // 提取缺失的参数名
              const requiredMatch = msg.match(/"path":\s*\[\s*"([^"]+)"\s*\]/);
              const paramName = requiredMatch ? requiredMatch[1] : "参数";

              console.error(`❌ 缺少必需参数: ${paramName}`);
              console.error(`💡 用法: ${slash.command} <${paramName}>`);
            } else {
              console.error(`❌ 参数错误`);
            }
          }
          // 其他错误
          else if (err.message) {
            const cleanMsg = String(err.message).split('\n')[0]; // 只显示第一行
            console.error(`❌ ${cleanMsg}`);
          } else {
            console.error(`❌ 发生错误`);
          }
        } else {
          console.error(`❌ ${String(error)}`);
        }
      }
      rl.prompt();
      return;
    }

    let codexPrompt: string | null = null;
    if (slash) {
      if (slash.command === "codex") {
        codexPrompt =
          slash.body ||
          "Explain how to confirm that the Codex SDK is authenticated correctly.";
      }
    } else {
      codexPrompt = effectiveLine;
    }

    if (codexPrompt && codexChat) {
      try {
        const turn = await codexChat.send(codexPrompt);
        // 直接输出响应内容，不显示前缀和 JSON 格式
        if (typeof turn.finalResponse === "string") {
          console.log(turn.finalResponse);
        } else if (turn.finalResponse) {
          // 如果是对象，尝试提取文本内容
          const text = extractResponseText(turn.finalResponse);
          console.log(text || JSON.stringify(turn.finalResponse, null, 2));
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : JSON.stringify(error);
        console.error("Error:", message);
      }
      rl.prompt();
      return;
    }

    if (codexPrompt && !codexChat) {
      console.error(
        "[Codex] Chat unavailable. Provide credentials or configure ~/.codex."
      );
      rl.prompt();
      return;
    }

    console.warn(
      "[Harness] Unrecognized command. Use '/ads.tool', '/codex', plain text, '/reset', or '/exit'."
    );
    rl.prompt();
  }).on("close", () => {
    process.exit(0);
  });
}

if (useLegacyClient) {
  main();
}

async function ensureWorkspace(adsTool: McpHarness) {
  const cwd = process.cwd();
  const marker = path.join(cwd, ".ads", "workspace.json");

  if (fs.existsSync(marker)) {
    console.log(`[ADS] Workspace detected at ${cwd}`);
    return;
  }

  console.log("[ADS] No workspace detected. Initializing via /ads.init ...");
  try {
    const result = await adsTool.call("ads.init", {
      name: path.basename(cwd),
    });
    const summary = extractToolText(result);
    if (summary) {
      try {
        const parsed = JSON.parse(summary);
        if (parsed?.workspace?.path) {
          console.log(`[ADS] Workspace initialized at ${parsed.workspace.path}`);
        } else {
          console.log("[ADS] Workspace initialized.");
        }
      } catch {
        console.log(`[ADS] ${summary}`);
      }
    } else {
      console.log("[ADS] Workspace initialized.");
    }
  } catch (error) {
    console.error("[ADS] Failed to initialize workspace automatically:", error);
  }
}

function extractToolText(result: any): string | null {
  if (
    result &&
    Array.isArray(result.content)
  ) {
    for (const item of result.content) {
      if (item?.type === "text" && typeof item.text === "string") {
        return item.text;
      }
    }
  }
  return null;
}

function extractResponseText(response: any): string | null {
  if (typeof response === "string") {
    return response;
  }
  if (response && typeof response === "object") {
    // 尝试提取常见的文本字段
    if (response.text) return String(response.text);
    if (response.content) return String(response.content);
    if (response.message) return String(response.message);
  }
  return null;
}

function printToolResult(toolName: string, result: any) {
  const text = extractToolText(result);
  if (text) {
    // 尝试解析 JSON 并显示友好的消息
    try {
      const parsed = JSON.parse(text);

      // ads.new - 工作流创建
      if (toolName === "ads.new" && parsed.success) {
        console.log(`✅ 工作流已创建`);
        if (parsed.message) {
          console.log(`💡 ${parsed.message}`);
        }
        return;
      }

      // ads.checkout - 工作流切换
      if (toolName === "ads.checkout") {
        if (parsed.success && parsed.message) {
          console.log(`✅ ${parsed.message}`);
        } else if (parsed.message) {
          console.log(parsed.message);
        } else {
          console.log(text);
        }
        return;
      }

      // 通用错误处理
      if (parsed.error) {
        console.log(`❌ ${parsed.error}`);
        return;
      }

      // 通用成功消息
      if (parsed.success && parsed.message) {
        console.log(`✅ ${parsed.message}`);
        return;
      }

      // 如果有 message 字段，优先显示
      if (parsed.message) {
        console.log(parsed.message);
        return;
      }

      // 否则显示原始文本（可能是纯文本不是 JSON）
      console.log(text);
    } catch {
      // 不是 JSON，直接显示文本
      console.log(text);
    }
    return;
  }

  if (result?.content && Array.isArray(result.content) && result.content.length > 0) {
    const fallback = result.content
      .map((item: any) => (typeof item?.text === "string" ? item.text : null))
      .filter(Boolean)
      .join("\n");
    if (fallback.trim().length > 0) {
      console.log(fallback);
      return;
    }
  }
  console.log(`(无响应)`);
}

// summarizeRequest 已移除 - 不再需要 MCP 调用日志
