import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { createAbortError, isAbortError } from '../../utils/abort.js';
import { createLogger } from '../../utils/logger.js';
import { resolveAdsStateDir } from '../../workspace/adsPaths.js';
import { createTimeoutSignal, formatFileSize, sanitizeFileName } from './downloadUtils.js';

function resolveDownloadDir(): string {
  return join(resolveAdsStateDir(), 'temp', 'url-downloads');
}

const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;
let dnsResolveOverride: ((hostname: string) => Promise<string[]>) | null = null;
const logger = createLogger('TelegramUrlHandler');

function cleanupDownloadedFile(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (error) {
    logger.warn(`Failed to cleanup ${filePath}`, error);
  }
}

/**
 * URL 类型
 */
export enum UrlType {
  IMAGE = 'image',
  FILE = 'file',
  WEBPAGE = 'webpage',
}

/**
 * URL 信息
 */
export interface UrlInfo {
  url: string;
  type: UrlType;
  extension?: string;
}

/**
 * 检测消息中的 URL
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  return matches || [];
}

/**
 * 判断 URL 类型
 */
export async function detectUrlType(url: string, signal?: AbortSignal): Promise<UrlInfo> {
  // 先通过扩展名判断
  const ext = extname(url.split('?')[0]).toLowerCase();
  
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
  const fileExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip', '.tar', '.gz', '.json', '.xml', '.csv', '.txt', '.md'];
  const webpageExts = ['.html', '.htm', '.php', '.asp', '.aspx', '.jsp'];
  
  if (imageExts.includes(ext)) {
    return { url, type: UrlType.IMAGE, extension: ext };
  }
  
  if (fileExts.includes(ext)) {
    return { url, type: UrlType.FILE, extension: ext };
  }
  
  if (webpageExts.includes(ext)) {
    return { url, type: UrlType.WEBPAGE, extension: ext };
  }
  
  // 通过 HEAD 请求检查 Content-Type（附加安全与超时保护）
  try {
    const parsed = new URL(url);
    await assertUrlSafe(parsed);
    const { signal: combinedSignal, cleanup } = createTimeoutSignal(signal, 5000);
    let response;
    try {
      response = await fetch(parsed.toString(), { method: 'HEAD', signal: combinedSignal });
    } finally {
      cleanup();
    }
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.startsWith('image/')) {
      return { url, type: UrlType.IMAGE, extension: ext || '.jpg' };
    }
    
    if (contentType.includes('text/html')) {
      return { url, type: UrlType.WEBPAGE, extension: ext };
    }
    
    if (contentType.includes('application/') || contentType.includes('text/')) {
      return { url, type: UrlType.FILE, extension: ext || '.bin' };
    }
  } catch (error) {
    logger.warn('Failed to detect URL type', error);
  }
  
  // 默认当作网页
  return { url, type: UrlType.WEBPAGE };
}

// 阻止的内网 IP
const BLOCKED_HOSTS = ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '169.254.169.254'];
const PRIVATE_IP_REGEX = [/^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^192\.168\./, /^127\./, /^169\.254\./];

// 检查 IP 是否为内网地址
function isPrivateIP(ip: string): boolean {
  if (BLOCKED_HOSTS.includes(ip)) return true;
  for (const regex of PRIVATE_IP_REGEX) {
    if (regex.test(ip)) return true;
  }
  return false;
}

function isIpAddress(hostname: string): boolean {
  return /^[\d.]+$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname);
}

async function assertUrlSafe(parsed: URL): Promise<void> {
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('只支持 HTTP/HTTPS 协议');
  }

  if (isPrivateIP(parsed.hostname)) {
    throw new Error('禁止访问内网地址');
  }

  if (isIpAddress(parsed.hostname)) {
    return;
  }

  try {
    const dns = await import('node:dns/promises');
    const resolver = dnsResolveOverride ?? dns.resolve.bind(dns);
    const addresses = await resolver(parsed.hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`域名 ${parsed.hostname} 解析到内网地址: ${addr}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && (err.message?.includes('内网') || err.message?.includes('解析到'))) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    // 其他 DNS 错误，阻止访问（安全优先）
    throw new Error(`DNS 解析失败: ${detail}`);
  }
}

// 仅用于测试注入自定义 DNS 解析行为
export function setDnsResolver(resolver: ((hostname: string) => Promise<string[]>) | null): void {
  dnsResolveOverride = resolver;
}

/**
 * 下载 URL 内容
 */
export async function downloadUrl(url: string, fileName: string, signal?: AbortSignal): Promise<string> {
  // 验证 URL 安全性
  const parsed = new URL(url);
  await assertUrlSafe(parsed);

  const downloadDir = resolveDownloadDir();
  if (!existsSync(downloadDir)) {
    mkdirSync(downloadDir, { recursive: true });
  }

  const timestamp = Date.now();
  const safeName = sanitizeFileName(fileName);
  const localPath = join(downloadDir, `${timestamp}-${safeName}`);

  // 超时控制
  const { signal: combinedSignal, cleanup } = createTimeoutSignal(signal, 30000);

  try {
    logger.info(`Downloading ${url}...`);

    const response = await fetch(url, { signal: combinedSignal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // 检查大小
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (Number.isFinite(size) && size > MAX_DOWNLOAD_SIZE) {
        throw new Error(`文件过大 (${formatFileSize(size)})，限制 50MB`);
      }
    }

    // 流式下载，限制大小
    if (!response.body) {
      throw new Error('No response body');
    }

    let downloadedSize = 0;
    const sizeLimiter = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedSize += chunk.length;
        if (downloadedSize > MAX_DOWNLOAD_SIZE) {
          callback(new Error('下载超过 50MB 限制'));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      sizeLimiter,
      createWriteStream(localPath),
      { signal: combinedSignal }
    );

    logger.info(`Downloaded to ${localPath}`);
    return localPath;
  } catch (error) {
    cleanupDownloadedFile(localPath);
    if (isAbortError(error)) {
      throw createAbortError('下载被中断');
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`下载失败: ${message}`, { cause: error });
  } finally {
    cleanup();
  }
}

/**
 * 处理消息中的 URLs
 */
export async function processUrls(text: string, signal?: AbortSignal): Promise<{
  processedText: string;
  imagePaths: string[];
  filePaths: string[];
  webpageUrls: string[];
}> {
  const urls = extractUrls(text);
  
  if (urls.length === 0) {
    return {
      processedText: text,
      imagePaths: [],
      filePaths: [],
      webpageUrls: [],
    };
  }
  
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const webpageUrls: string[] = [];
  
  for (const url of urls) {
    try {
      if (signal?.aborted) {
        throw createAbortError('链接处理已中断');
      }
      const info = await detectUrlType(url, signal);
      
      if (info.type === UrlType.IMAGE) {
        const fileName = `image${info.extension}`;
        const path = await downloadUrl(url, fileName, signal);
        imagePaths.push(path);
      } else if (info.type === UrlType.FILE) {
        const fileName = `file${info.extension}`;
        const path = await downloadUrl(url, fileName, signal);
        filePaths.push(path);
      } else {
        webpageUrls.push(url);
      }
    } catch (error) {
      logger.warn(`Failed to process URL ${url}`, error);
      // 失败的 URL 保留在文本中
    }
  }
  
  // 构建处理后的文本
  let processedText = text;
  
  if (imagePaths.length > 0) {
    processedText += `\n\n[已下载 ${imagePaths.length} 张图片]`;
  }
  
  if (filePaths.length > 0) {
    processedText += `\n\n[已下载 ${filePaths.length} 个文件]:`;
    for (const path of filePaths) {
      const fileName = path.split('/').pop() || 'file';
      processedText += `\n- ${fileName}: ${path}`;
    }
  }
  
  if (webpageUrls.length > 0) {
    processedText += `\n\n[网页链接]:`;
    for (const url of webpageUrls) {
      processedText += `\n- ${url}`;
    }
  }
  
  return {
    processedText,
    imagePaths,
    filePaths,
    webpageUrls,
  };
}
