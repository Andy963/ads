/**
 * 集中管理项目中的常量值
 */

// 文件大小限制
export const FILE_SIZE_LIMITS = {
  /** Web 端图片上传限制 (2MB) */
  WEB_IMAGE_MAX_BYTES: 2 * 1024 * 1024,
  /** Telegram Bot API 下载限制 (20MB) */
  TELEGRAM_DOWNLOAD_MAX_BYTES: 20 * 1024 * 1024,
  /** Telegram 上传限制 (50MB) */
  TELEGRAM_UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
} as const;

// 超时设置
export const TIMEOUTS = {
  /** 默认 HTTP 请求超时 (30秒) */
  HTTP_REQUEST_MS: 30_000,
  /** Tavily 搜索超时 (15秒) */
  TAVILY_SEARCH_MS: 15_000,
  /** WebSocket 重连延迟 (1.5秒) */
  WS_RECONNECT_MS: 1_500,
} as const;

// 重试设置
export const RETRY_CONFIG = {
  /** 默认重试次数 */
  DEFAULT_RETRIES: 3,
  /** 重试间隔基数 (毫秒) */
  RETRY_DELAY_BASE_MS: 1_000,
} as const;

// UI 相关
export const UI_LIMITS = {
  /** 日志消息最大数量 */
  MAX_LOG_MESSAGES: 300,
  /** 会话历史最大数量 */
  MAX_SESSION_HISTORY: 15,
  /** 命令输出最大行数 */
  COMMAND_OUTPUT_MAX_LINES: 10,
  /** 命令输出最大字符数 */
  COMMAND_OUTPUT_MAX_CHARS: 1_200,
} as const;
