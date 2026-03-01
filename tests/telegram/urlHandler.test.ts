import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { installTempAdsStateDir } from '../helpers/adsStateDir.js';
import { extractUrls, detectUrlType, UrlType, setDnsResolver, downloadUrl } from '../../server/telegram/utils/urlHandler.js';

function stubFetch(impl: typeof fetch) {
  const original = global.fetch;
  // @ts-expect-error partial fetch stub for tests
  global.fetch = impl;
  return () => {
    // @ts-expect-error restore
    global.fetch = original;
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
      setDnsResolver(async () => ['127.0.0.1']);
      try {
        const info = await detectUrlType('http://127.0.0.1/secret');
        assert.strictEqual(info.type, UrlType.WEBPAGE);
        assert.strictEqual(calls.length, 0, 'HEAD request should be skipped');
      } finally {
        restoreFetch();
        setDnsResolver(null);
      }
    });

    it('should avoid requests when DNS resolves to private network', async () => {
      const calls: Array<{ url: string }> = [];
      const restoreFetch = stubFetch(async (url) => {
        calls.push({ url: String(url) });
        throw new Error('fetch should not be called for private DNS');
      });
      setDnsResolver(async () => ['10.0.0.1']);
      try {
        const info = await detectUrlType('http://example.internal/resource');
        assert.strictEqual(info.type, UrlType.WEBPAGE);
        assert.strictEqual(calls.length, 0, 'HEAD request should be skipped');
      } finally {
        restoreFetch();
        setDnsResolver(null);
      }
    });

	    it('should perform HEAD for safe URLs with timeout signal', async () => {
	      const calls: Array<{ url: string; method?: string; signal?: AbortSignal }> = [];
	      const restoreFetch = stubFetch(async (url, options) => {
	        calls.push({ url: String(url), method: options?.method, signal: options?.signal });
	        return new Response('', { headers: { 'content-type': 'image/png' } });
	      });
	      setDnsResolver(async () => ['93.184.216.34']);
	      try {
	        const info = await detectUrlType('https://example.com/photo');
        assert.strictEqual(info.type, UrlType.IMAGE);
        assert.strictEqual(info.extension, '.jpg'); // falls back when no extension in URL
        assert.strictEqual(calls.length, 1, 'HEAD request should be made once');
        assert.strictEqual(calls[0].method, 'HEAD');
        assert.ok(calls[0].signal instanceof AbortSignal, 'HEAD should receive an AbortSignal');
      } finally {
        restoreFetch();
        setDnsResolver(null);
      }
	    });
	  });

  describe('downloadUrl', () => {
    it('should write downloaded content to disk', async () => {
      const adsState = installTempAdsStateDir('ads-state-url-download-');
      const restoreFetch = stubFetch(async (_url, options) => {
        assert.ok(options?.signal instanceof AbortSignal);
        const encoder = new TextEncoder();
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('hello'));
            controller.close();
          },
        });
        return new Response(body, { headers: { 'content-length': '5' } });
      });

      try {
        const localPath = await downloadUrl('https://93.184.216.34/hello', 'hello.txt');
        assert.ok(existsSync(localPath));
        assert.strictEqual(readFileSync(localPath, 'utf8'), 'hello');
      } finally {
        restoreFetch();
        adsState.restore();
      }
    });

    it('should cleanup partial files on stream error', async () => {
      const adsState = installTempAdsStateDir('ads-state-url-download-error-');
      const restoreFetch = stubFetch(async () => {
        let emitted = false;
        const body = new ReadableStream({
          pull(controller) {
            if (!emitted) {
              emitted = true;
              controller.enqueue(new Uint8Array([1, 2, 3]));
              return;
            }
            controller.error(new Error('stream boom'));
          },
        });

        return new Response(body, { headers: { 'content-length': '100' } });
      });

      try {
        await assert.rejects(downloadUrl('https://93.184.216.34/boom', 'boom.bin'), {
          message: /下载失败:/,
        });

        const downloadsDir = join(adsState.stateDir, 'temp', 'url-downloads');
        assert.deepStrictEqual(readdirSync(downloadsDir), []);
      } finally {
        restoreFetch();
        adsState.restore();
      }
    });

    it('should throw AbortError when fetch is aborted', async () => {
      const adsState = installTempAdsStateDir('ads-state-url-download-abort-');
      const restoreFetch = stubFetch(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      });

      try {
        await assert.rejects(downloadUrl('https://93.184.216.34/aborted', 'aborted.txt'), {
          name: 'AbortError',
          message: '下载被中断',
        });

        const downloadsDir = join(adsState.stateDir, 'temp', 'url-downloads');
        assert.ok(!existsSync(downloadsDir) || readdirSync(downloadsDir).length === 0);
      } finally {
        restoreFetch();
        adsState.restore();
      }
    });
  });
});
