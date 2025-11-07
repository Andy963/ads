import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export class DirectoryManager {
  private userCwds = new Map<number, string>();

  constructor(private readonly allowedDirs: string[]) {
    if (allowedDirs.length === 0) {
      throw new Error('Allowed directories list is empty');
    }
  }

  validatePath(path: string): boolean {
    try {
      // 解析符号链接获取真实路径
      const absolutePath = resolve(path);
      const realPath = existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
      
      for (const allowedDir of this.allowedDirs) {
        const allowedAbsolute = resolve(allowedDir);
        const allowedReal = existsSync(allowedAbsolute) ? realpathSync(allowedAbsolute) : allowedAbsolute;
        
        if (realPath === allowedReal || realPath.startsWith(allowedReal + '/')) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  getAllowedDirs(): string[] {
    return [...this.allowedDirs];
  }

  getUserCwd(userId: number): string {
    return this.userCwds.get(userId) || this.allowedDirs[0];
  }

  setUserCwd(userId: number, path: string): { success: boolean; error?: string } {
    const absolutePath = resolve(path);

    if (!this.validatePath(absolutePath)) {
      return {
        success: false,
        error: `目录不在白名单内。允许的目录：\n${this.allowedDirs.join('\n')}`,
      };
    }

    if (!existsSync(absolutePath)) {
      return {
        success: false,
        error: `目录不存在: ${absolutePath}`,
      };
    }

    this.userCwds.set(userId, absolutePath);
    return { success: true };
  }
}
