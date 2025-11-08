import { Api } from 'grammy';
import { createWriteStream, createReadStream, existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const DOWNLOAD_DIR = join(process.cwd(), '.ads', 'temp', 'telegram-files');
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB Telegram 限制
const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024; // 20MB Bot API 限制

/**
 * 确保下载目录存在
 */
function ensureDownloadDir(): void {
  if (!existsSync(DOWNLOAD_DIR)) {
    mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
}

/**
 * 下载 Telegram 文件到本地
 */
export async function downloadTelegramFile(
  api: Api,
  fileId: string,
  fileName: string,
  signal?: AbortSignal
): Promise<string> {
  ensureDownloadDir();
  
  try {
    // 获取文件信息
    const file = await api.getFile(fileId);
    
    // 检查文件大小
    if (file.file_size && file.file_size > MAX_DOWNLOAD_SIZE) {
      throw new Error(`文件过大 (${formatFileSize(file.file_size)})，限制 20MB`);
    }
    
    if (!file.file_path) {
      throw new Error('无法获取文件路径');
    }
    
    // 生成本地文件路径
    const timestamp = Date.now();
    const safeName = sanitizeFileName(fileName);
    const localPath = join(DOWNLOAD_DIR, `${timestamp}-${safeName}`);
    
    // 下载文件
    const fileUrl = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;
    const response = await fetch(fileUrl, { signal });
    
    if (!response.ok) {
      throw new Error(`下载失败: ${response.statusText}`);
    }
    
    // 保存到本地
    const buffer = await response.arrayBuffer();
    const fs = await import('node:fs/promises');
    await fs.writeFile(localPath, Buffer.from(buffer));
    
    console.log(`[FileHandler] Downloaded file: ${localPath} (${formatFileSize(buffer.byteLength)})`);
    return localPath;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      const abortError = new Error('文件下载被中断');
      abortError.name = 'AbortError';
      throw abortError;
    }
    throw new Error(`文件下载失败: ${(error as Error).message}`);
  }
}

/**
 * 上传文件给用户
 */
export async function uploadFileToTelegram(
  api: Api,
  chatId: number,
  filePath: string,
  caption?: string
): Promise<void> {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  
  const stats = statSync(filePath);
  
  // 检查文件大小
  if (stats.size > MAX_UPLOAD_SIZE) {
    throw new Error(`文件过大 (${formatFileSize(stats.size)})，限制 50MB`);
  }
  
  // 文件太大建议压缩
  if (stats.size > 10 * 1024 * 1024 && !filePath.endsWith('.gz')) {
    const compressed = await compressFile(filePath);
    const compressedStats = statSync(compressed);
    
    if (compressedStats.size < stats.size * 0.8) {
      console.log(`[FileHandler] Compressed ${formatFileSize(stats.size)} -> ${formatFileSize(compressedStats.size)}`);
      filePath = compressed;
    }
  }
  
  try {
    // 使用 InputFile 发送
    const fileName = basename(filePath);
    const { InputFile } = await import('grammy');
    
    await api.sendDocument(chatId, new InputFile(filePath), {
      caption: caption || `📁 ${fileName} (${formatFileSize(stats.size)})`,
    });
    
    console.log(`[FileHandler] Uploaded file: ${fileName}`);
  } catch (error) {
    throw new Error(`文件上传失败: ${(error as Error).message}`);
  }
}

/**
 * 压缩文件
 */
async function compressFile(filePath: string): Promise<string> {
  const compressedPath = `${filePath}.gz`;
  
  await pipeline(
    createReadStream(filePath),
    createGzip({ level: 9 }),
    createWriteStream(compressedPath)
  );
  
  return compressedPath;
}

/**
 * 清理下载的文件
 */
export function cleanupFile(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      console.log(`[FileHandler] Cleaned up: ${filePath}`);
    }
  } catch (error) {
    console.warn(`[FileHandler] Failed to cleanup ${filePath}:`, error);
  }
}

/**
 * 批量清理文件
 */
export function cleanupFiles(filePaths: string[]): void {
  for (const path of filePaths) {
    cleanupFile(path);
  }
}

/**
 * 清理所有临时文件（启动时调用）
 */
export function cleanupAllTempFiles(): void {
  if (!existsSync(DOWNLOAD_DIR)) {
    return;
  }
  
  const files = readdirSync(DOWNLOAD_DIR);
  
  let cleaned = 0;
  for (const file of files) {
    const filePath = join(DOWNLOAD_DIR, file);
    try {
      const stats = statSync(filePath);
      const age = Date.now() - stats.mtimeMs;
      
      // 清理超过1小时的文件
      if (age > 60 * 60 * 1000) {
        unlinkSync(filePath);
        cleaned++;
      }
    } catch (error) {
      // 忽略错误
    }
  }
  
  if (cleaned > 0) {
    console.log(`[FileHandler] Cleaned up ${cleaned} old temp files`);
  }
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 清理文件名中的非法字符
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 获取文件信息
 */
export interface FileInfo {
  name: string;
  size: number;
  path: string;
  mimeType?: string;
}

export async function getFileInfo(api: Api, fileId: string): Promise<FileInfo> {
  const file = await api.getFile(fileId);
  
  return {
    name: basename(file.file_path || 'unknown'),
    size: file.file_size || 0,
    path: file.file_path || '',
    mimeType: file.file_path?.split('.').pop(),
  };
}
