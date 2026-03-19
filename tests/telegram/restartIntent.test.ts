import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRestartIntent } from '../../server/telegram/utils/restartIntent.js';

describe('telegram restart intent', () => {
  it('parses self restart aliases', () => {
    assert.deepStrictEqual(parseRestartIntent('restart'), { scope: 'self' });
    assert.deepStrictEqual(parseRestartIntent('重启一下'), { scope: 'self' });
    assert.deepStrictEqual(parseRestartIntent('restart tg'), { scope: 'self' });
  });

  it('parses web and all restart aliases', () => {
    assert.deepStrictEqual(parseRestartIntent('restart web'), { scope: 'web' });
    assert.deepStrictEqual(parseRestartIntent('全部重启'), { scope: 'all' });
  });

  it('rejects empty, unknown, and oversized inputs', () => {
    assert.strictEqual(parseRestartIntent(''), null);
    assert.strictEqual(parseRestartIntent('hello world'), null);
    assert.strictEqual(parseRestartIntent('x'.repeat(65)), null);
  });
});
