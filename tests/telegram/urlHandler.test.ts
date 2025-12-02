import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractUrls, detectUrlType, UrlType } from '../../src/telegram/utils/urlHandler.js';

const dnsPromises = await import('node:dns/promises');

function stubFetch(impl: typeof fetch) {
  const original = global.fetch;
  // @ts-expect-error partial fetch stub for tests
  global.fetch = impl;
  return () => {
    // @ts-expect-error restore
    global.fetch = original;
  };
}

function stubDnsResolve(impl: typeof dnsPromises.resolve) {
  const original = dnsPromises.resolve;
  // @ts-expect-error override for tests
  dnsPromises.resolve = impl;
  return () => {
    dnsPromises.resolve = original;
  };
}

describe('UrlHandler', () => {
  describe('extractUrls', () => {
    it('should extract single URL', () => {
      const text = 'Check this https://example.com/page';
      const urls = extractUrls(text);
      assert.deepStrictEqual(urls, ['https://example.com/page']);
    });

    it('should extract multiple URLs', () => {
      const text = 'See https://example.com and http://test.org';
      const urls = extractUrls(text);
      assert.strictEqual(urls.length, 2);
    });

    it('should return empty array for no URLs', () => {
      const text = 'No links here';
      const urls = extractUrls(text);
      assert.deepStrictEqual(urls, []);
    });
  });

  describe('detectUrlType', () => {
    it('should detect image URL by extension', async () => {
      const info = await detectUrlType('https://example.com/image.png');
      assert.strictEqual(info.type, UrlType.IMAGE);
      assert.strictEqual(info.extension, '.png');
    });

    it('should detect file URL by extension', async () => {
      const info = await detectUrlType('https://example.com/data.json');
      assert.strictEqual(info.type, UrlType.FILE);
      assert.strictEqual(info.extension, '.json');
    });

    it('should detect webpage URL', async () => {
      const info = await detectUrlType('https://example.com/page.html');
      assert.strictEqual(info.type, UrlType.WEBPAGE);
    });

    it('should avoid requests to private IPs', async () => {
      const calls: Array<{ url: string }> = [];
      const restoreFetch = stubFetch(async (url) => {
        calls.push({ url: String(url) });
        throw new Error('fetch should not be called for private IP');
      });
      const restoreDns = stubDnsResolve(dnsPromises.resolve);
      try {
        const info = await detectUrlType('http://127.0.0.1/secret');
        assert.strictEqual(info.type, UrlType.WEBPAGE);
        assert.strictEqual(calls.length, 0, 'HEAD request should be skipped');
      } finally {
        restoreFetch();
        restoreDns();
      }
    });

    it('should avoid requests when DNS resolves to private network', async () => {
      const calls: Array<{ url: string }> = [];
      const restoreFetch = stubFetch(async (url) => {
        calls.push({ url: String(url) });
        throw new Error('fetch should not be called for private DNS');
      });
      const restoreDns = stubDnsResolve(async () => ['10.0.0.1']);
      try {
        const info = await detectUrlType('http://example.internal/resource');
        assert.strictEqual(info.type, UrlType.WEBPAGE);
        assert.strictEqual(calls.length, 0, 'HEAD request should be skipped');
      } finally {
        restoreFetch();
        restoreDns();
      }
    });

    it('should perform HEAD for safe URLs with timeout signal', async () => {
      const calls: Array<{ url: string; method?: string; signal?: AbortSignal }> = [];
      const restoreFetch = stubFetch(async (url, options) => {
        calls.push({ url: String(url), method: (options as any)?.method, signal: (options as any)?.signal });
        return {
          headers: {
            get: () => 'image/png',
          },
        } as any;
      });
      const restoreDns = stubDnsResolve(async () => ['93.184.216.34']);
      try {
        const info = await detectUrlType('https://example.com/photo');
        assert.strictEqual(info.type, UrlType.IMAGE);
        assert.strictEqual(info.extension, '.jpg'); // falls back when no extension in URL
        assert.strictEqual(calls.length, 1, 'HEAD request should be made once');
        assert.strictEqual(calls[0].method, 'HEAD');
        assert.ok(calls[0].signal instanceof AbortSignal, 'HEAD should receive an AbortSignal');
      } finally {
        restoreFetch();
        restoreDns();
      }
    });
  });
});
