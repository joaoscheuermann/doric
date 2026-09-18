import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Sandbox } from 'sandbox';

import { createTool } from '../tools/web.js';

const sandbox = { id: 'web', root: '/workspace' } as Sandbox;

describe('web tool', () => {
  test('parses DuckDuckGo search results and normalizes redirect URLs', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc&amp;rut=abc">Example &amp; Docs</a>
      <a class="result__snippet">A <b>short</b> snippet &amp; context.</a>
    `;
    const tool = createTool({ fetch: fakeFetch(html) })(sandbox);
    const result = await tool.execute({ action: 'search', query: 'docs' });

    assert.deepEqual(result.results, [
      {
        title: 'Example & Docs',
        url: 'https://example.com/doc',
        snippet: 'A short snippet & context.',
      },
    ]);

    assert.equal(result.total, 1);
  });

  test('extracts page text and finds literal matches case insensitively', async () => {
    const html = `
      <html><head><title>Example &amp; Page</title></head>
      <body><h1>Hello&nbsp;World</h1><p>Beta Needle</p><p>needle two</p></body></html>
    `;
    const tool = createTool({ fetch: fakeFetch(html) })(sandbox);

    const opened = await tool.execute({
      action: 'open_page',
      url: 'https://example.com/page',
    });

    const found = await tool.execute({
      action: 'find_in_page',
      url: 'https://example.com/page',
      pattern: 'needle',
      limit: 1,
    });

    assert.equal(opened.page?.title, 'Example & Page');

    assert.match(opened.page?.text ?? '', /Hello World/);

    assert.deepEqual(found.matches, [{ line: 2, text: 'Beta Needle' }]);

    assert.equal(found.total, 2);

    assert.equal(found.truncated, true);
  });

  test('aborts requests after the configured timeout', async () => {
    let observedAbort = false;

    const tool = createTool({
      requestTimeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            observedAbort = true;

            reject(new Error('aborted by test fetch'));
          });
        }),
    })(sandbox);

    const result = await tool.execute({
      action: 'open_page',
      url: 'https://example.com/slow',
    });

    assert.equal(observedAbort, true);

    assert.match(result.error ?? '', /timed out after 10ms/);
  });
});

const fakeFetch =
  (body: string) =>
  async (): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }> => ({
    ok: true,
    status: 200,
    text: async () => body,
  });
