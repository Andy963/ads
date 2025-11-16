import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { SessionManager } from '../../src/telegram/utils/sessionManager.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(1000, 500); // 1s timeout, 500ms cleanup
  });

  afterEach(() => {
    manager.destroy();
  });

  it('should create new session for user', () => {
    const session = manager.getOrCreate(123456);
    assert.ok(session);
  });

  it('should return same session for same user', () => {
    const session1 = manager.getOrCreate(123456);
    const session2 = manager.getOrCreate(123456);
    assert.strictEqual(session1, session2);
  });

  it('should reset session', () => {
    const session1 = manager.getOrCreate(123456);
    manager.reset(123456);
    const session2 = manager.getOrCreate(123456);
    
    // After reset, should be same object but with reset state
    assert.strictEqual(session1, session2);
    // Thread should be cleared after reset
    assert.strictEqual(session2.getThreadId(), null);
  });

  it('should track session statistics', () => {
    manager.getOrCreate(123456);
    manager.getOrCreate(789012);

    const stats = manager.getStats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.active, 2);
  });

  it('should save and retrieve thread ID', () => {
    manager.saveThreadId(123456, 'thread-123');
    assert.strictEqual(manager.hasSavedThread(123456), true);
    assert.strictEqual(manager.getSavedThreadId(123456), 'thread-123');
  });

  it('should clear persisted thread on reset even without active session', () => {
    manager.saveThreadId(123456, 'thread-abc');
    manager.reset(123456);
    assert.strictEqual(manager.hasSavedThread(123456), false);
  });
});
