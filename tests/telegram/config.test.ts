import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { loadTelegramConfig } from '../../src/telegram/config.js';

describe('Telegram Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load valid configuration', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALLOWED_USERS = '123456,789012';
    process.env.ALLOWED_DIRS = '/home/test,/project';

    const config = loadTelegramConfig();

    assert.strictEqual(config.botToken, 'test-token');
    assert.deepStrictEqual(config.allowedUsers, [123456, 789012]);
    assert.deepStrictEqual(config.allowedDirs, ['/home/test', '/project']);
  });

  it('should throw error when bot token is missing', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    
    assert.throws(() => loadTelegramConfig(), /TELEGRAM_BOT_TOKEN is required/);
  });

  it('should throw error when allowed users is missing', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.TELEGRAM_ALLOWED_USERS;
    
    assert.throws(() => loadTelegramConfig(), /TELEGRAM_ALLOWED_USERS is required/);
  });

  it('should use default values for optional configs', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALLOWED_USERS = '123456';

    const config = loadTelegramConfig();

    assert.strictEqual(config.maxRequestsPerMinute, 10);
    assert.ok(config.sessionTimeoutMs > 0);
  });
});
