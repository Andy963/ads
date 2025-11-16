/**
 * Unified Logger System
 * Provides consistent logging across the application
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export interface LoggerOptions {
  level?: LogLevel;
  prefix?: string;
  timestamp?: boolean;
}

export class Logger {
  private level: LogLevel;
  private prefix: string;
  private showTimestamp: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? (process.env.ADS_DEBUG === '1' ? LogLevel.DEBUG : LogLevel.INFO);
    this.prefix = options.prefix ?? '';
    this.showTimestamp = options.timestamp ?? false;
  }

  private formatMessage(_level: string, message: string): string {
    const parts: string[] = [];
    
    if (this.showTimestamp) {
      parts.push(`[${new Date().toISOString()}]`);
    }
    
    if (this.prefix) {
      parts.push(`[${this.prefix}]`);
    }
    
    parts.push(message);
    return parts.join(' ');
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.log(this.formatMessage('DEBUG', message), ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      console.log(this.formatMessage('INFO', message), ...args);
    }
  }

  log(message: string, ...args: unknown[]): void {
    this.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(this.formatMessage('WARN', message), ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(this.formatMessage('ERROR', message), ...args);
    }
  }

  /**
   * Create a child logger with additional prefix
   */
  child(prefix: string): Logger {
    const childPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    return new Logger({
      level: this.level,
      prefix: childPrefix,
      timestamp: this.showTimestamp
    });
  }

  /**
   * Set the log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

// Default logger instance
export const defaultLogger = new Logger();

// Factory function for creating module-specific loggers
export function createLogger(module: string, options?: Omit<LoggerOptions, 'prefix'>): Logger {
  return new Logger({
    ...options,
    prefix: module
  });
}
