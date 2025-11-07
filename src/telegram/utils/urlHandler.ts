import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const DOWNLOAD_DIR = join(process.cwd(), '.ads', 'temp', 'url-downloads');

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
export async function detectUrlType(url: string): Promise<UrlInfo> {
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
  
  // 通过 HEAD 请求检查 Content-Type
  try {
    const response = await fetch(url, { method: 'HEAD' });
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
    console.warn('[UrlHandler] Failed to detect URL type:', error);
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

/**
 * 下载 URL 内容
 */
export async function downloadUrl(url: string, fileName: string): Promise<string> {
  // 验证 URL 安全性
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('只支持 HTTP/HTTPS 协议');
  }
  
  // 检查主机名（直接检查是否为内网 IP）
  if (isPrivateIP(parsed.hostname)) {
    throw new Error('禁止访问内网地址');
  }
  
  // DNS 解析检查（防止 DNS 重绑定）
  // 如果主机名不是 IP 地址，需要解析 DNS
  const isIPAddress = /^[\d.]+$/.test(parsed.hostname) || /^[0-9a-f:]+$/i.test(parsed.hostname);
  
  if (!isIPAddress) {
    try {
      const dns = await import('node:dns/promises');
      const addresses = await dns.resolve(parsed.hostname);
      for (const addr of addresses) {
        if (isPrivateIP(addr)) {
          throw new Error(`域名 ${parsed.hostname} 解析到内网地址: ${addr}`);
        }
      }
    } catch (err: any) {
      if (err.message?.includes('内网') || err.message?.includes('解析到')) throw err;
      // 其他 DNS 错误，阻止访问（安全优先）
      throw new Error(`DNS 解析失败: ${err.message}`);
    }
  }
  
  if (!existsSync(DOWNLOAD_DIR)) {
    mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
  
  const timestamp = Date.now();
  const safeName = sanitizeFileName(fileName);
  const localPath = join(DOWNLOAD_DIR, `${timestamp}-${safeName}`);
  
  // 超时控制
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  
  try {
    console.log(`[UrlHandler] Downloading ${url}...`);
    
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    // 检查大小
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (size > 50 * 1024 * 1024) {
        throw new Error(`文件过大 (${formatFileSize(size)})，限制 50MB`);
      }
    }
    
    // 流式下载，限制大小
    if (!response.body) {
      throw new Error('No response body');
    }
    
    const fileStream = createWriteStream(localPath);
    const reader = response.body.getReader();
    let downloadedSize = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      downloadedSize += value.length;
      if (downloadedSize > 50 * 1024 * 1024) {
        fileStream.destroy();
        throw new Error(`下载超过 50MB 限制`);
      }
      
      fileStream.write(Buffer.from(value));
    }
    fileStream.end();
    
    console.log(`[UrlHandler] Downloaded to ${localPath}`);
    return localPath;
  } catch (error) {
    throw new Error(`下载失败: ${(error as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 处理消息中的 URLs
 */
export async function processUrls(text: string): Promise<{
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
      const info = await detectUrlType(url);
      
      if (info.type === UrlType.IMAGE) {
        const fileName = `image${info.extension}`;
        const path = await downloadUrl(url, fileName);
        imagePaths.push(path);
      } else if (info.type === UrlType.FILE) {
        const fileName = `file${info.extension}`;
        const path = await downloadUrl(url, fileName);
        filePaths.push(path);
      } else {
        webpageUrls.push(url);
      }
    } catch (error) {
      console.warn(`[UrlHandler] Failed to process URL ${url}:`, error);
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

/**
 * 清理文件名中的非法字符
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
