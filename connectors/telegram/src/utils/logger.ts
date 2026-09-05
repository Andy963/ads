export interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  debug: (msg: string, ...args: unknown[]) => void;
}

export function createLogger(prefix: string): Logger {
  const format = (level: string, msg: string) => `[${new Date().toISOString()}] [${level}] [${prefix}] ${msg}`;
  return {
    info: (msg, ...args) => console.log(format("INFO", msg), ...args),
    warn: (msg, ...args) => console.warn(format("WARN", msg), ...args),
    error: (msg, ...args) => console.error(format("ERROR", msg), ...args),
    debug: (msg, ...args) => {
      if (process.env.DEBUG) console.debug(format("DEBUG", msg), ...args);
    },
  };
}
