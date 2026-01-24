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
    assert.ok(typeof session.send === 'function');
    assert.ok(typeof session.onEvent === 'function');
    assert.ok(typeof session.getThreadId === 'function');
    assert.ok(typeof session.reset === 'function');
    assert.ok(typeof session.setModel === 'function');
    assert.ok(typeof session.setWorkingDirectory === 'function');
  });

  it('should return session wrapper for same user', () => {
    const session1 = manager.getOrCreate(123456);
    const session2 = manager.getOrCreate(123456);
    // Both should be wrappers with same methods (underlying session is the same)
    assert.ok(session1.send);
    assert.ok(session2.send);
  });

  it('should reset session', () => {
    manager.getOrCreate(123456);
    manager.reset(123456);
    const session2 = manager.getOrCreate(123456);
    
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

  it('should have saveThreadId as no-op in simplified version', () => {
    // saveThreadId is a no-op in simplified version
    manager.saveThreadId(123456, 'thread-123');
    // getSavedThreadId returns undefined in simplified version
    assert.strictEqual(manager.getSavedThreadId(123456), undefined);
  });

  it('should have getSavedState as no-op in simplified version', () => {
    manager.getOrCreate(123456, '/some/path');
    // getSavedState returns undefined in simplified version
    assert.strictEqual(manager.getSavedState(123456), undefined);
  });

  it('should track user model', () => {
    manager.setUserModel(123456, 'gpt-4o');
    assert.strictEqual(manager.getUserModel(123456), 'gpt-4o');
  });

  it('should track user cwd', () => {
    manager.getOrCreate(123456, '/home/test');
    assert.strictEqual(manager.getUserCwd(123456), '/home/test');
    
    manager.setUserCwd(123456, '/home/other');
    assert.strictEqual(manager.getUserCwd(123456), '/home/other');
  });
});
