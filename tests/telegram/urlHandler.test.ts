import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractUrls, detectUrlType, UrlType } from '../../src/telegram/utils/urlHandler.js';

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
  });
});
