import fs from "node:fs";
import path from "node:path";

import { detectWorkspace } from "../workspace/detector.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../workspace/adsPaths.js";
import type { AgentEvent } from "../codex/events.js";
import { createLogger } from "./logger.js";

const logger = createLogger("ConversationLogger");

function sanitizeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export class ConversationLogger {
  private readonly workspace: string;
  private readonly filePath: string;
  private readonly stream: fs.WriteStream;
  private recordedThreadId: string | null;
  private closed = false;

  constructor(workspacePath?: string, _userId?: number, threadId?: string) {
    this.workspace = workspacePath ? path.resolve(workspacePath) : detectWorkspace();
    migrateLegacyWorkspaceAdsIfNeeded(this.workspace);
    const logDir = resolveWorkspaceStatePath(this.workspace, "logs");
    fs.mkdirSync(logDir, { recursive: true });

    // 使用 threadId 或时间戳作为日志文件名，不包含用户ID
    let fileName: string;
    if (threadId) {
      fileName = `telegram-thread-${threadId}.log`;
    } else {
      const timestamp = sanitizeTimestamp(new Date());
      fileName = `session-${timestamp}.log`;
    }

    this.filePath = path.join(logDir, fileName);
    const fileExists = fs.existsSync(this.filePath);
    this.recordedThreadId = threadId ?? null;

    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });

    // 处理流错误，防止未捕获异常
    this.stream.on("error", (err) => {
      logger.error(`Stream error for ${this.filePath}: ${err.message}`, err);
    });

    // 只有新文件才写标题
    if (!fileExists) {
      this.stream.write(`# ADS Session ${new Date().toISOString()}\n`);
      if (threadId) {
        // 不在日志文件中记录用户ID，只记录线程ID
        this.stream.write(`# Thread ID: ${threadId}\n`);
      }
    } else {
      // 续写时添加分隔符
      this.stream.write(`\n# === Session resumed at ${new Date().toISOString()} ===\n`);
    }
  }

  get path(): string {
    return this.filePath;
  }

  logInput(input: string): void {
    this.stream.write(`${new Date().toISOString()} INPUT  > ${input}\n`);
  }

  logOutput(output: string): void {
    const lines = output.split(/\r?\n/);
    if (lines.length === 0) {
      return;
    }
    this.stream.write(`${new Date().toISOString()} OUTPUT > ${lines[0]}\n`);
    for (const line of lines.slice(1)) {
      this.stream.write(`                      ${line}\n`);
    }
  }

  logError(error: string): void {
    this.stream.write(`${new Date().toISOString()} ERROR  > ${error}\n`);
  }

  logEvent(event: AgentEvent): void {
    const summary = {
      phase: event.phase,
      title: event.title,
      detail: event.detail,
      rawType: event.raw?.type,
      eventTimestamp: new Date(event.timestamp).toISOString(),
    };
    this.stream.write(`${new Date().toISOString()} EVENT  > ${JSON.stringify(summary)}\n`);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stream.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 线程 ID 可能在日志文件创建后才可用（例如第一次消息时 Codex 还未返回 threadId）。
   * 允许在后续补充写入 threadId，避免漏记。
   */
  attachThreadId(threadId?: string | null): void {
    if (!threadId || this.recordedThreadId === threadId) {
      return;
    }
    this.stream.write(`# Thread ID: ${threadId}\n`);
    this.recordedThreadId = threadId;
  }
}
