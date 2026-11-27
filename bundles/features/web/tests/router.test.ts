// `web`'s host part through the router (phase 3, slice S50a, tests W1–W6;
// W1b, W2b, W3b and W3c ported from the deleted kernel entry's tests in S68a):
// `activate` registers the web tool with `tools/v1` as the kernel entry did
// (always available, position 700), and `core`'s `ToolHandlerService` calls
// run the same tool `createTool(options).bind(undefined)` answers directly.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { fromJson, type JsonValue, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import {
  createTool,
  type FetchLike,
  type FetchResponse,
} from '../src/host/tools/web.js';
import {
  type Harness,
  type HarnessOptions,
  harness,
} from './support/router.js';

/** A prompt call for running the tool directly, as the expected answer. */
const directCall = createTestServices({ bundle: { id: 'web' } }).call({
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
});

const SEARCH_HTML = `
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc&amp;rut=abc">Example &amp; Docs</a>
  <a class="result__snippet">A <b>short</b> snippet &amp; context.</a>
`;

const PAGE_HTML = `
  <html><head><title>Example &amp; Page</title></head>
  <body><h1>Hello&nbsp;World</h1><p>Beta Needle</p><p>needle two</p></body></html>
`;

/** A fetch fake that records each URL and answers `answer(url)`. */
const recordingFetch = (
  answer: (url: string) => Promise<FetchResponse>,
): { readonly fetch: FetchLike; readonly urls: string[] } => {
  const urls: string[] = [];

  return {
    urls,
    fetch: (url) => {
      urls.push(url);

      return answer(url);
    },
  };
};

/** A fetch fake that answers `body` with status 200. */
const okFetch = (body: string) =>
  recordingFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  }));

/** The Doric error of a failure: a `ContractError`, or read off a `ConnectError`. */
const contractErrorOf = (error: unknown): ContractError => {
  if (error instanceof ConnectError) {
    return fromConnectError(error);
  }

  assert.ok(isContractError(error), `expected a Doric error: ${error}`);

  return error;
};

/** The error `promise` rejects with; fails the test when it resolves. */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  return assert.fail('the call succeeded');
};

/** The part activated on a test router, stopped when the test ends. */
const activated = async (
  t: TestContext,
  options: HarnessOptions = {},
): Promise<Harness> => {
  const h = harness(options);

  t.after(() => h.router.control.stop());
  await h.activate();

  return h;
};

/** `Execute{name, payload, projectId?}`'s result as JSON. */
const executeJson = async (
  h: Harness,
  payload: JsonValue,
  name = 'web',
  projectId?: string,
): Promise<JsonValue | undefined> => {
  const { result } = await h.client.execute({
    name,
    payload: toValue(payload),
    ...(projectId === undefined ? {} : { projectId }),
  });

  return result === undefined ? undefined : toJson(ValueSchema, result);
};

/** `json` as a `google.protobuf.Value`. */
const toValue = (json: JsonValue) => fromJson(ValueSchema, json);

/** What the tool answers directly for `payload`, as JSON. */
const directJson = async (
  fetch: FetchLike,
  payload: Parameters<ReturnType<typeof bindDirect>['execute']>[0],
): Promise<JsonValue> =>
  JSON.parse(
    JSON.stringify(await bindDirect(fetch).execute(payload, directCall)),
  ) as JsonValue;

const bindDirect = (fetch: FetchLike) => createTool({ fetch }).bind(undefined);

void test('W1: activate sends one tools/v1.Register with the web tool, its schemas as JSON text, and {alwaysAvailable: true, order: 700}', async (t) => {
  const h = await activated(t);
  const { definition, description } = createTool();

  assert.deepEqual(h.registers, [
    {
      tool: {
        name: 'web',
        description,
        definition: {
          name: 'web',
          description: definition.description,
          inputSchema: JSON.stringify(definition.inputSchema),
          outputSchema: JSON.stringify(definition.outputSchema),
          strict: definition.strict,
        },
      },
      options: { alwaysAvailable: true, order: 700 },
    },
  ]);
});

void test('W2: Execute of a search answers, as JSON, what the tool bound to undefined answers directly', async (t) => {
  const served = okFetch(SEARCH_HTML);
  const direct = okFetch(SEARCH_HTML);
  const h = await activated(t, { tool: { fetch: served.fetch } });
  const payload = { action: 'search', query: 'docs' } as const;

  const result = await executeJson(h, payload);

  assert.deepEqual(result, await directJson(direct.fetch, payload));
  assert.deepEqual(served.urls, direct.urls);
  assert.equal(served.urls.length, 1);
});

void test('W3: Execute of a page fetch, and of a failing fetch, answers the tool’s own answer, not a call error', async (t) => {
  const page = okFetch(PAGE_HTML);
  const h = await activated(t, { tool: { fetch: page.fetch } });
  const open = {
    action: 'open_page',
    url: 'https://example.com/page',
  } as const;

  assert.deepEqual(
    await executeJson(h, open),
    await directJson(okFetch(PAGE_HTML).fetch, open),
  );

  const failing = () =>
    recordingFetch(async () => {
      throw new Error('offline');
    });
  const down = await activated(t, { tool: { fetch: failing().fetch } });
  const expected = await directJson(failing().fetch, open);

  assert.equal(
    (expected as { readonly error?: unknown }).error,
    'Request failed: offline',
  );
  assert.deepEqual(await executeJson(down, open), expected);
});

void test('W4: Check answers the tool’s check without calling fetch: issues for an invalid payload, the parsed data for a valid one', async (t) => {
  const fetch = okFetch(SEARCH_HTML);
  const h = await activated(t, { tool: { fetch: fetch.fetch } });
  const invalid = { action: 'browse', limit: -1 };
  const expected = createTool().bind(undefined).check(invalid);

  assert.equal(expected.success, false);

  const refused = await h.client.check({
    name: 'web',
    payload: toValue(invalid),
  });

  assert.equal(refused.success, false);
  assert.deepEqual(
    refused.issues.map(({ path, message }) => ({ path, message })),
    expected.success
      ? []
      : expected.issues.map(({ path, message }) => ({ path, message })),
  );

  const valid = { action: 'search', query: 'docs' };
  const accepted = await h.client.check({
    name: 'web',
    payload: toValue(valid),
  });

  assert.equal(accepted.success, true);
  assert.deepEqual(
    accepted.data === undefined
      ? undefined
      : toJson(ValueSchema, accepted.data),
    valid,
  );
  assert.deepEqual(fetch.urls, []);
});

void test('W5: Execute of another name, or of web under a Project, answers not_found', async (t) => {
  const fetch = okFetch(SEARCH_HTML);
  const h = await activated(t, { tool: { fetch: fetch.fetch } });
  const payload = { action: 'search', query: 'docs' };

  assert.equal(
    contractErrorOf(await rejectionOf(executeJson(h, payload, 'other'))).code,
    'not_found',
  );
  assert.equal(
    contractErrorOf(await rejectionOf(executeJson(h, payload, 'web', 'p')))
      .code,
    'not_found',
  );
  assert.deepEqual(fetch.urls, []);
});

void test('W6: a Register refused with duplicate_tool fails activate with it, and web is then not served', async (t) => {
  const fetch = okFetch(SEARCH_HTML);
  const h = harness({
    tool: { fetch: fetch.fetch },
    registerError: new ContractError('duplicate_tool', 'taken'),
  });

  t.after(() => h.router.control.stop());

  const error = contractErrorOf(await rejectionOf(h.activate()));

  assert.equal(error.code, 'duplicate_tool');
  assert.equal(h.registers.length, 1);
  assert.equal(
    contractErrorOf(
      await rejectionOf(executeJson(h, { action: 'search', query: 'docs' })),
    ).code,
    'not_found',
  );
  assert.deepEqual(fetch.urls, []);
});

// Ported from the kernel entry's `web.test.ts` and `activate.test.ts` (S68a):
// the tool's own answers, as values, through `ToolHandlerService`.

void test('W1b (S68a, from activate.test.ts): the registered web tool carries the established description, and a blank search query answers the tool’s error', async (t) => {
  const h = await activated(t, { tool: { fetch: okFetch(SEARCH_HTML).fetch } });

  assert.equal(
    (h.registers[0] as { readonly tool?: { readonly description?: string } })
      .tool?.description,
    'Search the web, open HTTP(S) pages as extracted text, or find literal text in a page.',
  );
  assert.equal(
    (
      (await executeJson(h, { action: 'search', query: ' ' })) as {
        readonly error?: string;
      }
    ).error,
    'Missing query for search',
  );
});

void test('W2b (S68a, from web.test.ts): Execute of a search parses DuckDuckGo results and normalizes their redirect URLs', async (t) => {
  const h = await activated(t, { tool: { fetch: okFetch(SEARCH_HTML).fetch } });

  const result = (await executeJson(h, {
    action: 'search',
    query: 'docs',
  })) as { readonly results?: unknown; readonly total?: unknown };

  assert.deepEqual(result.results, [
    {
      title: 'Example & Docs',
      url: 'https://example.com/doc',
      snippet: 'A short snippet & context.',
    },
  ]);
  assert.equal(result.total, 1);
});

void test('W3b (S68a, from web.test.ts): Execute of open_page extracts the page text, and find_in_page finds literal matches case insensitively', async (t) => {
  const h = await activated(t, { tool: { fetch: okFetch(PAGE_HTML).fetch } });

  const opened = (await executeJson(h, {
    action: 'open_page',
    url: 'https://example.com/page',
  })) as {
    readonly page?: { readonly title?: string; readonly text?: string };
  };
  const found = (await executeJson(h, {
    action: 'find_in_page',
    url: 'https://example.com/page',
    pattern: 'needle',
    limit: 1,
  })) as {
    readonly matches?: unknown;
    readonly total?: unknown;
    readonly truncated?: unknown;
  };

  assert.equal(opened.page?.title, 'Example & Page');
  assert.match(opened.page?.text ?? '', /Hello World/);
  assert.deepEqual(found.matches, [{ line: 2, text: 'Beta Needle' }]);
  assert.equal(found.total, 2);
  assert.equal(found.truncated, true);
});

void test('W3c (S68a, from web.test.ts): Execute aborts a request after the configured timeout and answers the tool’s timeout error', async (t) => {
  let observedAbort = false;
  const h = await activated(t, {
    tool: {
      requestTimeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            observedAbort = true;
            reject(new Error('aborted by test fetch'));
          });
        }),
    },
  });

  const result = (await executeJson(h, {
    action: 'open_page',
    url: 'https://example.com/slow',
  })) as { readonly error?: string };

  assert.equal(observedAbort, true);
  assert.match(result.error ?? '', /timed out after 10ms/);
});
