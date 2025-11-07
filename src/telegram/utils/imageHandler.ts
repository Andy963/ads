import { createWriteStream, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Api } from 'grammy';

const TEMP_DIR = join(process.cwd(), '.ads', 'temp', 'telegram-images');

// 确保临时目录存在
function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }
}

export async function downloadTelegramImage(
  api: Api,
  fileId: string,
  fileName: string
): Promise<string> {
  ensureTempDir();

  // 获取文件信息
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Failed to get file path from Telegram');
  }

  // 构建下载 URL
  const botToken = process.env.TELEGRAM_BOT_TOKEN!;
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

  // 保存到临时文件
  const localPath = join(TEMP_DIR, `${Date.now()}-${fileName}`);
  
  // 下载文件
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  const fileStream = createWriteStream(localPath);
  await pipeline(response.body as any, fileStream);

  console.log(`[ImageHandler] Downloaded image to ${localPath}`);
  return localPath;
}

export function cleanupImage(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      console.log(`[ImageHandler] Cleaned up ${path}`);
    }
  } catch (error) {
    console.warn(`[ImageHandler] Failed to cleanup ${path}:`, error);
  }
}

export function cleanupImages(paths: string[]): void {
  for (const path of paths) {
    cleanupImage(path);
  }
}
