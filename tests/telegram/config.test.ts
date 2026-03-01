import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { loadTelegramConfig } from '../../server/telegram/config.js';

describe('Telegram Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_ALLOWED_USER_ID;
    delete process.env.TELEGRAM_ALLOWED_USERS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load valid configuration', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALLOWED_USER_ID = '123456';
    process.env.ALLOWED_DIRS = '/home/test,/project';

    const config = loadTelegramConfig();

    assert.strictEqual(config.botToken, 'test-token');
    assert.deepStrictEqual(config.allowedUsers, [123456]);
    assert.deepStrictEqual(config.allowedDirs, ['/home/test', '/project']);
  });

  it('should accept TELEGRAM_ALLOWED_USERS as legacy single-user alias', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALLOWED_USERS = '123456';

    const config = loadTelegramConfig();
    assert.deepStrictEqual(config.allowedUsers, [123456]);
  });

  it('should reject TELEGRAM_ALLOWED_USERS with multiple values', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALLOWED_USERS = '123456,789012';

    assert.throws(() => loadTelegramConfig(), /TELEGRAM_ALLOWED_USERS must contain exactly one user ID/);
  });

  it('should reject conflicting TELEGRAM_ALLOWED_USER_ID and TELEGRAM_ALLOWED_USERS', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALLOWED_USER_ID = '123456';
    process.env.TELEGRAM_ALLOWED_USERS = '789012';

    assert.throws(() => loadTelegramConfig(), /conflicts with TELEGRAM_ALLOWED_USERS/);
  });

  it('should throw error when bot token is missing', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    
    assert.throws(() => loadTelegramConfig(), /TELEGRAM_BOT_TOKEN is required/);
  });

  it('should throw error when allowed users is missing', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.TELEGRAM_ALLOWED_USER_ID;
    delete process.env.TELEGRAM_ALLOWED_USERS;
    
    assert.throws(() => loadTelegramConfig(), /TELEGRAM_ALLOWED_USER_ID is required/);
  });

  it('should use default values for optional configs', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALLOWED_USER_ID = '123456';
    delete process.env.TELEGRAM_MAX_RPM;
    delete process.env.TELEGRAM_SESSION_TIMEOUT;

    const config = loadTelegramConfig();

    assert.strictEqual(config.maxRequestsPerMinute, 10);
    // Default disables session timeout cleanup.
    assert.strictEqual(config.sessionTimeoutMs, 0);
  });
});
