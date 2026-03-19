import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createGracefulCleanup } from '../../server/utils/shutdown.js';

describe('telegram graceful cleanup', () => {
  it('runs shutdown cleanup once and exits with code 0', () => {
    const calls: string[] = [];
    const cleanup = createGracefulCleanup({
      logger: {
        info(message: string) {
          calls.push(`info:${message}`);
        },
        warn(message: string) {
          calls.push(`warn:${message}`);
        },
        error(message: string) {
          calls.push(`error:${message}`);
        },
      },
      destroySessionManager: () => {
        calls.push('destroySessionManager');
      },
      stopBot: () => {
        calls.push('stopBot');
      },
      closeWorkspaceDatabases: () => {
        calls.push('closeWorkspaceDatabases');
      },
      closeStateDatabases: () => {
        calls.push('closeStateDatabases');
      },
      exit: (code: number) => {
        calls.push(`exit:${code}`);
      },
    });

    cleanup.shutdown('bye');
    cleanup.shutdown('ignored');

    assert.deepStrictEqual(calls, [
      'info:bye',
      'destroySessionManager',
      'stopBot',
      'closeWorkspaceDatabases',
      'closeStateDatabases',
      'exit:0',
    ]);
  });

  it('runs crash cleanup once and exits with code 1', () => {
    const calls: string[] = [];
    const cleanup = createGracefulCleanup({
      logger: {
        info(message: string) {
          calls.push(`info:${message}`);
        },
        warn(message: string) {
          calls.push(`warn:${message}`);
        },
        error(message: string, error?: unknown) {
          calls.push(`error:${message}:${error instanceof Error ? error.message : String(error ?? '')}`);
        },
      },
      closeWorkspaceDatabases: () => {
        calls.push('closeWorkspaceDatabases');
      },
      closeStateDatabases: () => {
        calls.push('closeStateDatabases');
      },
      exit: (code: number) => {
        calls.push(`exit:${code}`);
      },
    });

    cleanup.crash('boom', new Error('fail'));
    cleanup.crash('ignored', new Error('again'));

    assert.deepStrictEqual(calls, [
      'error:boom:fail',
      'closeWorkspaceDatabases',
      'closeStateDatabases',
      'exit:1',
    ]);
  });
});
