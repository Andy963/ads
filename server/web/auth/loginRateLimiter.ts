import { parsePositiveIntFlag } from "../../utils/flags.js";

export interface LoginRateLimiterOptions {
  /** 触发锁定前允许的连续失败次数（默认 5）。 */
  maxAttempts?: number;
  /** 基础锁定时长（毫秒）；每次再次触发锁定按 2 的幂指数退避（默认 5 分钟）。 */
  baseLockoutMs?: number;
  /** 锁定时长上限（毫秒），用于封顶指数退避（默认 baseLockoutMs * 12）。 */
  maxLockoutMs?: number;
  /** 记录条目上限，超过后清理已解锁条目以防内存膨胀（默认 50000）。 */
  maxEntries?: number;
  /** 可注入的时钟，仅供测试。 */
  now?: () => number;
}

interface AttemptRecord {
  failures: number;
  lockLevel: number;
  lockedUntil: number;
}

export interface LoginLockState {
  locked: boolean;
  retryAfterMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_LOCKOUT_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 50_000;

/**
 * 内存态登录失败限流：按 key（用户名小写 + 客户端 IP）分别计失败次数，达到阈值后临时锁定，
 * 重复触发指数退避；成功登录清零对应 key。重启即清空（单机场景可接受）。
 *
 * 锁定状态在凭据校验之前检查，且对任意用户名返回一致的结果，避免泄露用户是否存在。
 */
export class LoginRateLimiter {
  private readonly maxAttempts: number;
  private readonly baseLockoutMs: number;
  private readonly maxLockoutMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly records = new Map<string, AttemptRecord>();

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.baseLockoutMs = Math.max(1000, Math.floor(options.baseLockoutMs ?? DEFAULT_BASE_LOCKOUT_MS));
    this.maxLockoutMs = Math.max(this.baseLockoutMs, Math.floor(options.maxLockoutMs ?? this.baseLockoutMs * 12));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? ((): number => Date.now());
  }

  /** 任一 key 处于锁定窗口内即视为锁定，retryAfterMs 取剩余时间的最大值。 */
  check(keys: string[]): LoginLockState {
    const now = this.now();
    let retryAfterMs = 0;
    for (const key of this.normalizeKeys(keys)) {
      const record = this.records.get(key);
      if (record && record.lockedUntil > now) {
        retryAfterMs = Math.max(retryAfterMs, record.lockedUntil - now);
      }
    }
    return { locked: retryAfterMs > 0, retryAfterMs };
  }

  recordFailure(keys: string[]): void {
    const now = this.now();
    this.pruneIfNeeded(now);
    for (const key of this.normalizeKeys(keys)) {
      const record = this.records.get(key) ?? { failures: 0, lockLevel: 0, lockedUntil: 0 };
      // 锁定窗口内的失败不重复累加（这些请求本应被 check 拦截）。
      if (record.lockedUntil > now) {
        this.records.set(key, record);
        continue;
      }
      record.failures += 1;
      if (record.failures >= this.maxAttempts) {
        const duration = Math.min(this.maxLockoutMs, this.baseLockoutMs * 2 ** record.lockLevel);
        record.lockedUntil = now + duration;
        record.lockLevel += 1;
        record.failures = 0;
      }
      this.records.set(key, record);
    }
  }

  recordSuccess(keys: string[]): void {
    for (const key of this.normalizeKeys(keys)) {
      this.records.delete(key);
    }
  }

  private normalizeKeys(keys: string[]): string[] {
    const out: string[] = [];
    for (const key of keys) {
      const trimmed = String(key ?? "").trim();
      if (trimmed) {
        out.push(trimmed);
      }
    }
    return out;
  }

  private pruneIfNeeded(now: number): void {
    if (this.records.size < this.maxEntries) {
      return;
    }
    for (const [key, record] of this.records) {
      if (record.lockedUntil <= now) {
        this.records.delete(key);
      }
    }
  }
}

/** 构造限流 key：用户名（小写）与客户端 IP 双键，任一缺失则省略。 */
export function buildLoginRateLimitKeys(username: string, ip: string | null): string[] {
  const keys: string[] = [];
  const normalizedUser = String(username ?? "").trim().toLowerCase();
  if (normalizedUser) {
    keys.push(`u:${normalizedUser}`);
  }
  const normalizedIp = String(ip ?? "").trim();
  if (normalizedIp) {
    keys.push(`ip:${normalizedIp}`);
  }
  return keys;
}

let singleton: LoginRateLimiter | null = null;

export function getLoginRateLimiter(): LoginRateLimiter {
  if (!singleton) {
    singleton = new LoginRateLimiter({
      maxAttempts: parsePositiveIntFlag(process.env.ADS_WEB_LOGIN_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
      baseLockoutMs: parsePositiveIntFlag(process.env.ADS_WEB_LOGIN_LOCKOUT_MS, DEFAULT_BASE_LOCKOUT_MS),
    });
  }
  return singleton;
}

/** 仅供测试：重置内存中的限流单例。 */
export function resetLoginRateLimiterForTests(): void {
  singleton = null;
}
