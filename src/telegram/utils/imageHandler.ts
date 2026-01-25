import { createWriteStream, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import type { Api } from 'grammy';

import { createLogger } from '../../utils/logger.js';
import { resolveAdsStateDir } from '../../workspace/adsPaths.js';
import { resolveTelegramProxyAgent } from './proxyAgent.js';

const TEMP_DIR = join(resolveAdsStateDir(), 'temp', 'telegram-images');
const logger = createLogger('TelegramImageHandler');

// 确保临时目录存在
function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const abortHandler = () => controller.abort();
  if (parent) {
    if (parent.aborted) {
      controller.abort();
    } else {
      parent.addEventListener('abort', abortHandler);
    }
  }

  const cleanup = () => {
    clearTimeout(timeout);
    if (parent) {
      parent.removeEventListener('abort', abortHandler);
    }
  };

  return { signal: controller.signal, cleanup, didTimeout: () => timedOut };
}

export async function downloadTelegramImage(
  api: Api,
  fileId: string,
  fileName: string,
  signal?: AbortSignal
): Promise<string> {
  ensureTempDir();

  // 获取文件信息
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Failed to get file path from Telegram');
  }

  // 保存到临时文件
  const localPath = join(TEMP_DIR, `${Date.now()}-${fileName}`);
  
  // 下载文件（需要时走 TELEGRAM_PROXY_URL）
  const fileUrl = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;
  const agent = resolveTelegramProxyAgent();
  const { signal: combinedSignal, cleanup, didTimeout } = createTimeoutSignal(signal, 30_000);

  try {
    await new Promise<void>((resolve, reject) => {
      const req = https.request(fileUrl, { agent, signal: combinedSignal }, (res) => {
        const statusCode = res.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          const statusText = `${statusCode} ${res.statusMessage ?? ''}`.trim();
          res.resume();
          reject(new Error(`Failed to download image: HTTP ${statusText}`));
          return;
        }

        const fileStream = createWriteStream(localPath);
        pipeline(res, fileStream).then(resolve).catch(reject);
      });

      req.on('error', reject);
      req.end();
    });
  } catch (error) {
    cleanupImage(localPath);
    if ((error as Error).name === 'AbortError') {
      const abortError = new Error(didTimeout() ? '图片下载超时' : '图片下载被中断');
      abortError.name = 'AbortError';
      throw abortError;
    }
    throw error;
  } finally {
    cleanup();
  }

  logger.info(`Downloaded image to ${localPath}`);
  return localPath;
}

export function cleanupImage(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      logger.debug(`Cleaned up ${path}`);
    }
  } catch (error) {
    logger.warn(`Failed to cleanup ${path}`, error);
  }
}

export function cleanupImages(paths: string[]): void {
  for (const path of paths) {
    cleanupImage(path);
  }
}
