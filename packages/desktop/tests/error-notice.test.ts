/**
 * `ErrorNotice` and `toastError` (`desktop/ui/error-notice`) show one failure
 * the same way on every surface (spec `docs/designs/error-messages.md`
 * §2.2–§4). The catalog rule (`describeError`) is not exported, so it is
 * exercised through what a rendered notice shows.
 *
 * Contract matrix:
 * - T-3: every shared code shows its table title, and Retry exactly when the
 *   table says "yes".
 * - T-4: the headline level (first with an entry, `internal` skipped), a
 *   bundle catalog winning, `fallbackCode`, the `unknown` fallback, the first
 *   line cut at 200 characters, `{provider}`, the level's `retryable` veto,
 *   the warning tone, the last fallback sentence.
 * - T-5: the open details text and the copied text, line by line.
 * - T-6: the markup of each variant through roles, ARIA and data attributes.
 * - T-7: Details open/close, Copy details feedback for 1 500 ms, Retry.
 * - T-8: `toastError` with the window's `Toaster`: replacement by id, a
 *   4 000 ms life that stops while the details are open, toast-only ARIA.
 * - T-36: an announced notice is `role="alert"` the first time the window
 *   shows its key, under `StrictMode` too, and `role="group"` on a remount.
 *
 * The imports resolve through the package's export map, so this exercises
 * the files the windows load.
 */
import assert from 'node:assert/strict';
import {
  after,
  afterEach,
  before,
  describe,
  type TestContext,
  test,
} from 'node:test';

import type { ErrorCatalog, ErrorInfo } from 'desktop/reads';
import type { ErrorNoticeProps } from 'desktop/ui/error-notice';
import { Window } from 'happy-dom';
import type { LucideIcon } from 'lucide-react';

const window = new Window();
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'SVGElement',
  'ShadowRoot',
  'DocumentFragment',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'PointerEvent',
  'MouseEvent',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

let notices: typeof import('desktop/ui/error-notice');
let sonner: typeof import('desktop/ui/sonner');
let icons: typeof import('lucide-react');
let createRoot: typeof import('react-dom/client').createRoot;
let createElement: typeof import('react').createElement;
let StrictMode: typeof import('react').StrictMode;
let act: (callback: () => void | Promise<void>) => Promise<void>;

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (window as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import('react');
  act = react.act as typeof act;
  createElement = react.createElement;
  StrictMode = react.StrictMode;
  ({ createRoot } = await import('react-dom/client'));
  [notices, sonner, icons] = await Promise.all([
    import('desktop/ui/error-notice'),
    import('desktop/ui/sonner'),
    import('lucide-react'),
  ]);
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

afterEach(() => {
  delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
  document.body.replaceChildren();
});

/* ------------------------------------------------------------------ */
/* Fixtures and queries                                                */
/* ------------------------------------------------------------------ */

let unique = 0;

/** An `ErrorInfo` with no causes and no time unless given. */
const failure = (fields: Partial<ErrorInfo> = {}): ErrorInfo => ({
  code: '',
  message: '',
  causes: [],
  ...fields,
});

/** A failure no other test has shown, so the window's announced set lacks it. */
const fresh = (fields: Partial<ErrorInfo> = {}): ErrorInfo => {
  unique += 1;
  return failure({
    code: 'not_found',
    message: `Failure number ${unique}.`,
    at: '2026-11-16T12:00:00.000Z',
    ...fields,
  });
};

interface Mounted {
  readonly host: HTMLElement;
  readonly notice: () => HTMLElement;
  readonly rerender: (props: ErrorNoticeProps) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

/** Renders one `ErrorNotice` into a fresh element of the document. */
const mount = async (
  props: ErrorNoticeProps,
  options: { readonly strict?: boolean } = {},
): Promise<Mounted> => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (next: ErrorNoticeProps) =>
    act(() => {
      const node = createElement(notices.ErrorNotice, next);
      root.render(
        options.strict === true ? createElement(StrictMode, null, node) : node,
      );
    });
  await draw(props);

  return {
    host,
    notice: () => {
      const found = host.querySelector<HTMLElement>(
        '[data-slot="error-notice"]',
      );
      assert.ok(found, 'no [data-slot="error-notice"] rendered');
      return found;
    },
    rerender: draw,
    unmount: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
};

/** Renders a node on its own and returns the markup inside its `<svg>`. */
const glyph = async (Icon: LucideIcon): Promise<string> => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement(Icon)));
  const markup = host.querySelector('svg')?.innerHTML ?? '';
  await act(() => root.unmount());
  return markup;
};

const buttons = (scope: Element): HTMLButtonElement[] => [
  ...scope.querySelectorAll<HTMLButtonElement>('button'),
];

/** The icon-only action named `label`, or `undefined`. */
const action = (scope: Element, label: string) =>
  buttons(scope).find((button) => button.getAttribute('aria-label') === label);

/** The Details link, whichever words it shows. */
const detailsLink = (scope: Element) =>
  buttons(scope).find((button) =>
    ['Details', 'Hide details'].includes(button.textContent?.trim() ?? ''),
  );

/** The title element: the one that carries the whole title in `title`. */
const titleOf = (notice: Element): HTMLElement => {
  const found = [...notice.querySelectorAll<HTMLElement>('[title]')].find(
    (element) => element.tagName !== 'BUTTON',
  );
  assert.ok(found, 'no title element');
  return found;
};

/** The explanation, found through the notice's `aria-describedby`. */
const explanationOf = (notice: Element): HTMLElement | undefined => {
  const id = notice.getAttribute('aria-describedby');
  if (id === null) return undefined;
  return document.getElementById(id) ?? undefined;
};

/** The open details `<pre>`, or `undefined` when the details are closed. */
const openDetails = (scope: Element): HTMLElement | undefined => {
  const pre = scope.querySelector<HTMLElement>('pre');
  if (pre === null || pre.closest('[hidden]') !== null) return undefined;
  return pre;
};

/** Presses `button` and lets React and pending promises settle. */
const press = async (button: HTMLElement | undefined): Promise<void> => {
  assert.ok(button, 'the button to press is missing');
  await act(async () => {
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
  });
};

/**
 * Replaces the clock with a mocked one and returns `advance(ms)`, which moves
 * it in 10 ms steps so a timer started by another timer runs on time.
 *
 * Node's mocked `setTimeout` mis-orders a call without a delay (Sonner's
 * `setTimeout(fn)`), so a missing delay is passed as 0.
 */
const fakeClock = (context: TestContext) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const mocked = globalThis.setTimeout;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => mocked(callback, delay ?? 0, ...args)) as typeof setTimeout;

  return (ms: number) =>
    act(() => {
      for (let done = 0; done < ms; done += 10) {
        context.mock.timers.tick(Math.min(10, ms - done));
      }
      context.mock.timers.tick(0);
    });
};

/** Puts a clipboard double on the window's navigator; returns the writes. */
const stubClipboard = (outcome: 'resolve' | 'reject' | 'absent'): string[] => {
  const written: string[] = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value:
      outcome === 'absent'
        ? undefined
        : {
            writeText: (text: string) => {
              written.push(text);
              return outcome === 'resolve'
                ? Promise.resolve()
                : Promise.reject(new Error('denied'));
            },
          },
  });
  return written;
};

/* ------------------------------------------------------------------ */
/* T-3: the shared catalog                                             */
/* ------------------------------------------------------------------ */

/** §2.2, shared table: code → title and the entry's Retry flag. */
const sharedTable: ReadonlyArray<readonly [string, string, boolean]> = [
  ['unknown', 'Something went wrong', true],
  ['internal', 'Something went wrong', true],
  ['unavailable', 'Doric host unavailable', true],
  ['disconnected', 'Doric host unavailable', true],
  ['generation_lost', 'Doric host unavailable', true],
  ['protocol_error', 'Doric host unavailable', true],
  ['invalid_output', 'Unexpected output', true],
  ['invalid_input', 'Request refused', false],
  ['not_found', 'Not found', false],
  ['conflict', 'Not possible right now', false],
  ['revision_conflict', 'Changed elsewhere', true],
  ['limit_exceeded', 'Limit reached', false],
  ['credential_missing', 'Credential not found', false],
  ['credential_invalid', 'Credential rejected', false],
  ['credential_name_taken', 'Name already used', false],
  ['credential_kind_immutable', 'Kind cannot change', false],
  ['credential_storage_unavailable', 'Secret storage unavailable', true],
  ['network_error', 'Provider unreachable', true],
  ['incomplete_stream', 'Response cut off', true],
  ['rate_limit_error', 'Rate limit reached', true],
  ['overloaded_error', 'Provider overloaded', true],
  ['api_error', 'Provider error', true],
  ['provider_error', 'Provider error', true],
  ['http_error', 'Provider request failed', true],
  ['auth_failed', 'Sign-in rejected', false],
  ['auth_missing', 'Credentials missing', false],
  ['auth_ambiguous', 'Credentials ambiguous', false],
  ['malformed_stream_event', 'Unreadable response', true],
  ['missing_stream_finish', 'Unreadable response', true],
  ['invalid_json', 'Unreadable data', true],
  ['missing_model', 'No model chosen', false],
  ['unsupported_model_feature', 'Not supported by the model', false],
  ['incompatible_model_request', 'Not supported by the model', false],
  ['output_truncated', 'Response too long', true],
  ['provider_refusal', 'The model refused', false],
  ['turn_limit_exceeded', 'Turn limit reached', true],
  ['missing_provider_finish', 'Response ended early', true],
  ['invalid_structured_output', 'Unexpected model output', true],
  ['concurrent_run', 'Already running', false],
  ['tool_call_id_collision', 'Invalid tool call', true],
  ['tool_call_id_invalid', 'Invalid tool call', true],
  ['tool_input_serialization_failed', 'Invalid tool call', true],
  ['tool_result_serialization_failed', 'Invalid tool call', true],
  ['handler_failed', 'Tool failed', false],
  ['invalid_payload', 'Invalid tool input', false],
  ['unknown_tool', 'Unknown tool', false],
  ['invalid_schema', 'Invalid tool definition', false],
];

describe('the shared catalog titles every shared code (T-3)', () => {
  for (const [code, title, retry] of sharedTable) {
    test(`${code}: "${title}", ${retry ? 'with' : 'without'} Retry`, async () => {
      const view = await mount({
        error: failure({ code, message: 'What the host said.' }),
        onRetry: () => undefined,
      });

      assert.equal(titleOf(view.notice()).textContent, title);
      assert.equal(action(view.notice(), 'Retry') !== undefined, retry);
      await view.unmount();
    });
  }
});

/* ------------------------------------------------------------------ */
/* T-4: the catalog rule, through the rendered notice                  */
/* ------------------------------------------------------------------ */

/** What a rendered notice shows: title, explanation, Retry and tone. */
const shown = async (
  error: ErrorInfo,
  options: {
    readonly catalog?: ErrorCatalog;
    readonly fallbackCode?: string;
  } = {},
) => {
  const view = await mount({ error, onRetry: () => undefined, ...options });
  const notice = view.notice();
  const result = {
    title: titleOf(notice).textContent,
    explanation: explanationOf(notice)?.textContent,
    retry: action(notice, 'Retry') !== undefined,
    tone: notice.getAttribute('data-tone'),
  };
  await view.unmount();
  return result;
};

describe('the notice picks its words from the catalog (T-4)', () => {
  test('heads with the first level, outermost first, whose code has an entry', async () => {
    assert.deepEqual(
      await shown(
        failure({
          code: 'some_unlisted_code',
          message: 'Outer words.',
          causes: [
            { code: 'another_unlisted_code', message: 'Middle words.' },
            { code: 'not_found', message: 'No such file: a.txt' },
            { code: 'rate_limit_error', message: 'Too many requests.' },
          ],
        }),
      ),
      {
        title: 'Not found',
        explanation: 'No such file: a.txt',
        retry: false,
        tone: 'error',
      },
    );
  });

  test('skips internal when a deeper level has an entry', async () => {
    assert.deepEqual(
      await shown(
        failure({
          code: 'internal',
          message: 'Unexpected host failure.',
          causes: [
            {
              code: 'rate_limit_error',
              provider: 'anthropic',
              message: 'Too many requests.',
            },
          ],
        }),
      ),
      {
        title: 'Rate limit reached',
        explanation:
          'anthropic is limiting requests; wait a moment, then retry.',
        retry: true,
        tone: 'error',
      },
    );
  });

  test('heads with the first internal level when no other level has an entry', async () => {
    const result = await shown(
      failure({
        code: 'some_unlisted_code',
        message: 'Outer words.',
        causes: [{ code: 'internal', message: 'Raw host text.' }],
      }),
    );

    assert.equal(result.title, 'Something went wrong');
    assert.equal(result.explanation, 'Raw host text.');
    assert.equal(result.retry, true);
  });

  test("uses a bundle catalog's entry over the shared one", async () => {
    assert.deepEqual(
      await shown(failure({ code: 'not_found', message: 'Gone.' }), {
        catalog: {
          not_found: {
            title: 'Thread not found',
            explanation: 'The thread was deleted.',
            retryable: true,
          },
        },
      }),
      {
        title: 'Thread not found',
        explanation: 'The thread was deleted.',
        retry: true,
        tone: 'error',
      },
    );
  });

  test("titles a bundle's own code from its catalog", async () => {
    const result = await shown(
      failure({ code: 'queue_paused', message: 'The host stopped.' }),
      {
        catalog: {
          queue_paused: { title: 'Execution paused', retryable: true },
        },
      },
    );

    assert.equal(result.title, 'Execution paused');
    assert.equal(result.explanation, 'The host stopped.');
    assert.equal(result.retry, true);
  });

  test('uses fallbackCode when no level has an entry', async () => {
    assert.deepEqual(
      await shown(failure({ code: '', message: 'Disk full.' }), {
        catalog: {
          send_failed: { title: 'Prompt not sent', retryable: false },
        },
        fallbackCode: 'send_failed',
      }),
      {
        title: 'Prompt not sent',
        explanation: 'Disk full.',
        retry: false,
        tone: 'error',
      },
    );
  });

  test('prefers a level with an entry over fallbackCode', async () => {
    const result = await shown(
      failure({ code: 'conflict', message: 'Busy.' }),
      {
        catalog: {
          send_failed: { title: 'Prompt not sent', retryable: false },
        },
        fallbackCode: 'send_failed',
      },
    );

    assert.equal(result.title, 'Not possible right now');
  });

  test('falls back to unknown with the first line of the message', async () => {
    assert.deepEqual(
      await shown(
        failure({
          code: 'some_unlisted_code',
          message: 'First line of the failure.\nSecond line.',
        }),
        { fallbackCode: 'code_with_no_entry' },
      ),
      {
        title: 'Something went wrong',
        explanation: 'First line of the failure.',
        retry: true,
        tone: 'error',
      },
    );
  });

  test('cuts a first line over 200 characters to 199 and an ellipsis', async () => {
    const long = 'a'.repeat(250);

    const result = await shown(failure({ message: `${long}\nmore` }));

    assert.equal(result.explanation, `${'a'.repeat(199)}…`);
  });

  test('keeps a first line of exactly 200 characters whole', async () => {
    const exact = 'b'.repeat(200);

    assert.equal((await shown(failure({ message: exact }))).explanation, exact);
  });

  test("takes the outer message when the headline level's message is empty", async () => {
    const result = await shown(
      failure({
        code: 'some_unlisted_code',
        message: 'Outer words.',
        causes: [{ code: 'not_found', message: '' }],
      }),
    );

    assert.equal(result.title, 'Not found');
    assert.equal(result.explanation, 'Outer words.');
  });

  test('ends with the generic sentence when no level has a message', async () => {
    const result = await shown(failure());

    assert.equal(result.title, 'Something went wrong');
    assert.equal(result.explanation, 'The operation could not be completed.');
  });

  test("puts the headline level's provider into {provider}", async () => {
    const result = await shown(
      failure({
        code: 'internal',
        provider: 'outer-provider',
        message: 'x',
        causes: [{ code: 'network_error', provider: 'openai', message: 'y' }],
      }),
    );

    assert.equal(result.explanation, 'Doric could not reach openai.');
  });

  test("falls back to the outer provider, then to 'the provider'", async () => {
    assert.equal(
      (
        await shown(
          failure({
            code: 'internal',
            provider: 'outer-provider',
            message: 'x',
            causes: [{ code: 'network_error', message: 'y' }],
          }),
        )
      ).explanation,
      'Doric could not reach outer-provider.',
    );
    assert.equal(
      (await shown(failure({ code: 'network_error', message: 'y' })))
        .explanation,
      'Doric could not reach the provider.',
    );
  });

  test('lets the level veto Retry: an HTTP 400 is not retryable', async () => {
    const result = await shown(
      failure({
        code: 'http_error',
        provider: 'openai',
        status: 400,
        retryable: false,
        message: 'Bad request.',
      }),
    );

    assert.equal(result.title, 'Provider request failed');
    assert.equal(result.explanation, 'openai answered with an error status.');
    assert.equal(result.retry, false);
  });

  test('keeps Retry for an http_error level that says it is retryable', async () => {
    const result = await shown(
      failure({
        code: 'http_error',
        status: 503,
        retryable: true,
        message: 'Unavailable.',
      }),
    );

    assert.equal(result.retry, true);
  });

  test('cannot turn on Retry for an entry that is not retryable', async () => {
    const result = await shown(
      failure({ code: 'invalid_input', retryable: true, message: 'Bad.' }),
    );

    assert.equal(result.retry, false);
  });

  test("takes the level's own flag for the unknown fallback", async () => {
    assert.equal(
      (await shown(failure({ message: 'x', retryable: false }))).retry,
      false,
    );
    assert.equal((await shown(failure({ message: 'x' }))).retry, true);
  });

  test("shows an entry's warning tone", async () => {
    const result = await shown(failure({ code: 'resume_exhausted' }), {
      catalog: {
        resume_exhausted: {
          title: 'Execution stopped',
          explanation: 'The host restarted three times.',
          retryable: true,
          tone: 'warning',
        },
      },
    });

    assert.equal(result.tone, 'warning');
  });
});

/* ------------------------------------------------------------------ */
/* T-5: details and copy text                                          */
/* ------------------------------------------------------------------ */

const detailed = failure({
  code: 'rate_limit_error',
  provider: 'anthropic',
  status: 429,
  message: 'Too many requests.\nSlow down.',
  causes: [
    {
      code: 'overloaded_error',
      provider: 'anthropic',
      status: 529,
      message: 'Overloaded',
    },
    { message: 'socket hang up' },
    { code: 'http_error', status: 500, message: 'Server error' },
    { code: 'api_error', provider: 'openai', message: 'Upstream' },
  ],
  at: '2026-11-16T12:00:00.000Z',
});

const detailedContext = { Thread: 'thread-1', Prompt: 'prompt-2\nretried' };

const detailedText = [
  'Code: rate_limit_error',
  'Provider: anthropic',
  'Status: 429',
  'Message: Too many requests.',
  '  Slow down.',
  'Caused by: [overloaded_error] Overloaded (anthropic, 529)',
  'Caused by: socket hang up',
  'Caused by: [http_error] Server error (500)',
  'Caused by: [api_error] Upstream (openai)',
  'Thread: thread-1',
  'Prompt: prompt-2',
  '  retried',
  'Time: 2026-11-16T12:00:00.000Z',
].join('\n');

const detailedCopy = [
  'Rate limit reached',
  'anthropic is limiting requests; wait a moment, then retry.',
  '',
  detailedText,
].join('\n');

describe('the details and the copy text (T-5)', () => {
  test('the open details show every line of §3.4, in order', async () => {
    const view = await mount({ error: detailed, context: detailedContext });

    await press(detailsLink(view.notice()));

    assert.equal(openDetails(view.notice())?.textContent, detailedText);
    await view.unmount();
  });

  test('Copy details writes the title, the explanation and the details', async () => {
    const written = stubClipboard('resolve');
    const view = await mount({ error: detailed, context: detailedContext });

    await press(action(view.notice(), 'Copy details'));

    assert.deepEqual(written, [detailedCopy]);
    await view.unmount();
  });

  test('an inline notice copies the same text', async () => {
    const written = stubClipboard('resolve');
    const view = await mount({
      error: detailed,
      context: detailedContext,
      variant: 'inline',
    });

    await press(action(view.notice(), 'Copy details'));

    assert.deepEqual(written, [detailedCopy]);
    await view.unmount();
  });

  test('a notice with no code, message or time says "none" and has no Message or Time line', async () => {
    const written = stubClipboard('resolve');
    const view = await mount({
      error: failure({ code: '', message: '' }),
    });

    await press(detailsLink(view.notice()));

    assert.equal(openDetails(view.notice())?.textContent, 'Code: none');
    await press(action(view.notice(), 'Copy details'));
    assert.deepEqual(written, [
      [
        'Something went wrong',
        'The operation could not be completed.',
        '',
        'Code: none',
      ].join('\n'),
    ]);
    await view.unmount();
  });
});

/* ------------------------------------------------------------------ */
/* T-6: markup                                                         */
/* ------------------------------------------------------------------ */

describe('the notice markup (T-6)', () => {
  test('a block notice shows its title, explanation, Copy details and a closed Details link', async () => {
    const view = await mount({
      error: failure({ code: 'not_found', message: 'No such file: a.txt' }),
    });
    const notice = view.notice();

    assert.equal(notice.getAttribute('data-variant'), 'block');
    assert.equal(notice.getAttribute('data-tone'), 'error');
    const title = titleOf(notice);
    assert.equal(title.textContent, 'Not found');
    assert.equal(title.getAttribute('title'), 'Not found');
    const copy = action(notice, 'Copy details');
    assert.equal(copy?.getAttribute('title'), 'Copy details');
    assert.equal(copy?.textContent?.trim(), '');
    assert.equal(action(notice, 'Retry'), undefined);
    const link = detailsLink(notice);
    assert.equal(link?.textContent?.trim(), 'Details');
    assert.equal(link?.getAttribute('aria-expanded'), 'false');
    assert.equal(link?.getAttribute('type'), 'button');
    assert.equal(openDetails(notice), undefined);
    await view.unmount();
  });

  test('the explanation is its own element after row 1, named by aria-describedby, and row 2 ends with the Details link', async () => {
    const view = await mount({
      error: failure({ code: 'not_found', message: 'No such file: a.txt' }),
    });
    const notice = view.notice();
    const explanation = explanationOf(notice);

    assert.equal(explanation?.textContent, 'No such file: a.txt');
    const row = explanation?.parentElement;
    assert.ok(row);
    assert.ok(!row.contains(titleOf(notice)));
    const link = detailsLink(notice);
    assert.ok(link && row.contains(link));
    assert.equal(row.lastElementChild, link);
    assert.ok(
      titleOf(notice).compareDocumentPosition(explanation as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
    await view.unmount();
  });

  test('row 2 holds only the Details link when the explanation is empty', async () => {
    const view = await mount({
      error: failure({ code: 'blank_code', message: 'Ignored.' }),
      catalog: {
        blank_code: { title: 'Blank', explanation: '   ', retryable: false },
      },
    });
    const notice = view.notice();
    const link = detailsLink(notice);

    assert.ok(link);
    assert.equal(link.parentElement?.children.length, 1);
    assert.equal(link.parentElement?.textContent?.trim(), 'Details');
    assert.equal(notice.getAttribute('aria-describedby'), null);
    await view.unmount();
  });

  test('a compact notice has the same rows and data-variant="compact"', async () => {
    const view = await mount({
      error: failure({ code: 'not_found', message: 'Gone.' }),
      variant: 'compact',
    });
    const notice = view.notice();

    assert.equal(notice.getAttribute('data-variant'), 'compact');
    assert.equal(explanationOf(notice)?.textContent, 'Gone.');
    assert.ok(detailsLink(notice));
    await view.unmount();
  });

  test('an inline notice has row 1 only: no explanation, no Details link and no details', async () => {
    const view = await mount({
      error: failure({ code: 'not_found', message: 'Gone.' }),
      variant: 'inline',
    });
    const notice = view.notice();

    assert.equal(notice.getAttribute('data-variant'), 'inline');
    assert.equal(titleOf(notice).textContent, 'Not found');
    assert.ok(action(notice, 'Copy details'));
    assert.equal(explanationOf(notice), undefined);
    assert.ok(!notice.textContent?.includes('Gone.'));
    assert.equal(detailsLink(notice), undefined);
    assert.equal(notice.querySelector('pre'), null);
    await view.unmount();
  });

  test('Retry shows only with onRetry and a retryable headline', async () => {
    const retryable = failure({ code: 'unavailable', message: 'Gone.' });

    const without = await mount({ error: retryable });
    assert.equal(action(without.notice(), 'Retry'), undefined);
    await without.unmount();

    const withIt = await mount({ error: retryable, onRetry: () => undefined });
    const retry = action(withIt.notice(), 'Retry');
    assert.equal(retry?.getAttribute('title'), 'Retry');
    assert.equal(retry?.textContent?.trim(), '');
    assert.equal(retry?.disabled, false);
    assert.notEqual(retry?.getAttribute('aria-busy'), 'true');
    await withIt.unmount();
  });

  test('Retry is disabled and busy only while retrying', async () => {
    const view = await mount({
      error: failure({ code: 'unavailable', message: 'Gone.' }),
      onRetry: () => undefined,
      retrying: true,
    });

    const retry = action(view.notice(), 'Retry');
    assert.equal(retry?.disabled, true);
    assert.equal(retry?.getAttribute('aria-busy'), 'true');

    await view.rerender({
      error: failure({ code: 'unavailable', message: 'Gone.' }),
      onRetry: () => undefined,
      retrying: false,
    });
    const after = action(view.notice(), 'Retry');
    assert.equal(after?.disabled, false);
    assert.notEqual(after?.getAttribute('aria-busy'), 'true');
    await view.unmount();
  });

  test('draws CircleAlertIcon for the error tone and TriangleAlertIcon for the warning tone', async () => {
    const error = await mount({ error: failure({ code: 'not_found' }) });
    assert.equal(
      error.notice().querySelector('svg')?.innerHTML,
      await glyph(icons.CircleAlertIcon),
    );
    await error.unmount();

    const warning = await mount({
      error: failure({ code: 'resume_exhausted' }),
      catalog: {
        resume_exhausted: {
          title: 'Execution stopped',
          retryable: true,
          tone: 'warning',
        },
      },
    });
    assert.equal(warning.notice().getAttribute('data-tone'), 'warning');
    assert.equal(
      warning.notice().querySelector('svg')?.innerHTML,
      await glyph(icons.TriangleAlertIcon),
    );
    await warning.unmount();
  });

  test('icon replaces the tone glyph', async () => {
    const view = await mount({
      error: failure({ code: 'not_found' }),
      icon: icons.PackageXIcon,
    });

    assert.equal(
      view.notice().querySelector('svg')?.innerHTML,
      await glyph(icons.PackageXIcon),
    );
    await view.unmount();
  });

  test('keeps the caller className on the root', async () => {
    const view = await mount({
      error: failure({ code: 'not_found' }),
      className: 'caller-class',
    });

    assert.ok(view.notice().classList.contains('caller-class'));
    await view.unmount();
  });

  test('an unannounced notice is a group named by its title', async () => {
    const view = await mount({ error: failure({ code: 'not_found' }) });
    const notice = view.notice();

    assert.equal(notice.getAttribute('role'), 'group');
    const labelledBy = notice.getAttribute('aria-labelledby');
    assert.ok(labelledBy);
    assert.equal(document.getElementById(labelledBy), titleOf(notice));
    await view.unmount();
  });
});

/* ------------------------------------------------------------------ */
/* T-7: interaction                                                    */
/* ------------------------------------------------------------------ */

describe('the notice in use (T-7)', () => {
  test('Details opens the details and Hide details closes them', async () => {
    const view = await mount({
      error: failure({ code: 'not_found', message: 'Gone.' }),
    });

    await press(detailsLink(view.notice()));
    let link = detailsLink(view.notice());
    assert.equal(link?.getAttribute('aria-expanded'), 'true');
    assert.equal(link?.textContent?.trim(), 'Hide details');
    const pre = openDetails(view.notice());
    assert.ok(pre);
    assert.equal(pre.getAttribute('aria-label'), 'Error details');
    assert.equal(pre.getAttribute('tabindex'), '0');

    await press(link);
    link = detailsLink(view.notice());
    assert.equal(link?.getAttribute('aria-expanded'), 'false');
    assert.equal(link?.textContent?.trim(), 'Details');
    assert.equal(openDetails(view.notice()), undefined);
    await view.unmount();
  });

  test('Copy details reports "Copied" with CheckIcon for 1 500 ms', async (context: TestContext) => {
    const advance = fakeClock(context);
    stubClipboard('resolve');
    const view = await mount({ error: failure({ code: 'not_found' }) });

    await press(action(view.notice(), 'Copy details'));

    const copied = action(view.notice(), 'Copied');
    assert.ok(copied, 'no "Copied" button after the copy');
    assert.equal(copied.getAttribute('title'), 'Copied');
    assert.equal(
      copied.querySelector('svg')?.innerHTML,
      await glyph(icons.CheckIcon),
    );
    const status = view.notice().querySelector('[role="status"]');
    assert.equal(status?.getAttribute('aria-live'), 'polite');
    assert.equal(status?.textContent?.trim(), 'Copied');

    await advance(1499);
    assert.ok(action(view.notice(), 'Copied'));
    await advance(1);
    assert.equal(action(view.notice(), 'Copied'), undefined);
    assert.ok(action(view.notice(), 'Copy details'));
    await view.unmount();
  });

  for (const outcome of ['reject', 'absent'] as const) {
    test(`Copy details reports "Copy failed" when the clipboard ${outcome === 'reject' ? 'refuses' : 'is missing'}`, async (context: TestContext) => {
      const advance = fakeClock(context);
      stubClipboard(outcome);
      const view = await mount({ error: failure({ code: 'not_found' }) });

      await press(action(view.notice(), 'Copy details'));

      const failed = action(view.notice(), 'Copy failed');
      assert.ok(failed, 'no "Copy failed" button after the copy');
      assert.equal(
        failed.querySelector('svg')?.innerHTML,
        await glyph(icons.CopyIcon),
      );
      await advance(1500);
      assert.ok(action(view.notice(), 'Copy details'));
      await view.unmount();
    });
  }

  test('Retry calls onRetry once per press', async () => {
    let calls = 0;
    const view = await mount({
      error: failure({ code: 'unavailable' }),
      onRetry: () => {
        calls += 1;
      },
    });

    await press(action(view.notice(), 'Retry'));

    assert.equal(calls, 1);
    await view.unmount();
  });

  test('Retry does nothing while retrying', async () => {
    let calls = 0;
    const view = await mount({
      error: failure({ code: 'unavailable' }),
      onRetry: () => {
        calls += 1;
      },
      retrying: true,
    });

    await press(action(view.notice(), 'Retry'));

    assert.equal(calls, 0);
    await view.unmount();
  });
});

/* ------------------------------------------------------------------ */
/* T-8: toasts                                                         */
/* ------------------------------------------------------------------ */

/** Mounts the window's Toaster with mocked timers; returns its controls. */
const toaster = async (context: TestContext) => {
  const advance = fakeClock(context);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(createElement(sonner.Toaster)));
  const surfaces = () => [
    ...document.querySelectorAll<HTMLElement>('[data-slot="error-toast"]'),
  ];
  const surface = (): HTMLElement | undefined => surfaces()[0];
  const notice = (): HTMLElement => {
    const found = surface()?.querySelector<HTMLElement>(
      '[data-slot="error-notice"]',
    );
    assert.ok(found, 'no notice inside the toast');
    return found;
  };
  const show = async (input: Parameters<typeof notices.toastError>[0]) => {
    await act(() => notices.toastError(input));
    await advance(0);
  };

  context.after(async () => {
    sonner.toast.dismiss();
    await act(() => root.unmount());
  });

  return { advance, surfaces, surface, notice, show };
};

describe('toastError (T-8)', () => {
  test('shows one compact notice in a toast surface, with Copy details and Details and no Retry or alert', async (context) => {
    const t = await toaster(context);

    await t.show({
      id: 't8-shape',
      error: fresh({ code: 'unavailable', message: 'Host gone.' }),
    });

    assert.equal(t.surfaces().length, 1);
    const notice = t.notice();
    assert.equal(notice.getAttribute('data-variant'), 'compact');
    assert.equal(titleOf(notice).textContent, 'Doric host unavailable');
    assert.ok(action(notice, 'Copy details'));
    assert.ok(detailsLink(notice));
    assert.equal(action(notice, 'Retry'), undefined);
    assert.equal(document.querySelector('[role="alert"]'), null);
  });

  test("passes the input's catalog, fallbackCode and context to the notice", async (context) => {
    const t = await toaster(context);

    await t.show({
      id: 't8-props',
      error: failure({ message: 'Disk full.' }),
      catalog: {
        config_save_failed: { title: 'Settings not saved', retryable: true },
      },
      fallbackCode: 'config_save_failed',
      context: { Thread: 'thread-9' },
    });

    assert.equal(titleOf(t.notice()).textContent, 'Settings not saved');
    await press(detailsLink(t.notice()));
    assert.ok(
      openDetails(t.notice())?.textContent?.includes('Thread: thread-9'),
    );
  });

  test('a second call with the same id replaces the toast with a fresh, closed notice', async (context) => {
    const t = await toaster(context);
    await t.show({
      id: 't8-replace',
      error: failure({ code: 'not_found', message: 'First.' }),
    });
    await press(detailsLink(t.notice()));
    assert.ok(openDetails(t.notice()));

    await t.show({
      id: 't8-replace',
      error: failure({ code: 'conflict', message: 'Second.' }),
    });

    assert.equal(t.surfaces().length, 1);
    assert.equal(titleOf(t.notice()).textContent, 'Not possible right now');
    assert.equal(
      detailsLink(t.notice())?.getAttribute('aria-expanded'),
      'false',
    );
    assert.equal(openDetails(t.notice()), undefined);
  });

  test('lives 4 000 ms with its details closed', async (context) => {
    const t = await toaster(context);
    await t.show({ id: 't8-life', error: failure({ code: 'not_found' }) });

    await t.advance(3900);
    assert.ok(t.surface());
    await t.advance(600);
    assert.equal(t.surface(), undefined);
  });

  test('does not expire while its details are open, and expires 4 000 ms after they close', async (context) => {
    const t = await toaster(context);
    await t.show({ id: 't8-open', error: failure({ code: 'not_found' }) });

    await press(detailsLink(t.notice()));
    await t.advance(0);
    await t.advance(10_000);
    assert.ok(t.surface(), 'the toast expired with its details open');
    assert.ok(openDetails(t.notice()));

    await press(detailsLink(t.notice()));
    await t.advance(0);
    await t.advance(3900);
    assert.ok(t.surface());
    await t.advance(600);
    assert.equal(t.surface(), undefined);
  });

  test('a call made while the details are open expires 4 000 ms later', async (context) => {
    const t = await toaster(context);
    await t.show({ id: 't8-reopen', error: failure({ code: 'not_found' }) });
    await press(detailsLink(t.notice()));
    await t.advance(5000);

    await t.show({ id: 't8-reopen', error: failure({ code: 'conflict' }) });

    await t.advance(3900);
    assert.ok(t.surface());
    await t.advance(600);
    assert.equal(t.surface(), undefined);
  });

  test('inside a toast the status has no role and the open details are not live', async (context) => {
    const t = await toaster(context);
    stubClipboard('resolve');
    await t.show({ id: 't8-aria', error: failure({ code: 'not_found' }) });

    await press(detailsLink(t.notice()));
    await press(action(t.notice(), 'Copy details'));

    const notice = t.notice();
    assert.equal(notice.querySelector('[role="status"]'), null);
    assert.equal(
      openDetails(notice)?.closest('[aria-live]')?.getAttribute('aria-live'),
      'off',
    );
    for (const live of notice.querySelectorAll('[aria-live]')) {
      assert.equal(live.getAttribute('aria-live'), 'off');
    }
    assert.notEqual(notice.getAttribute('role'), 'alert');
  });

  test("a success toast with another id leaves the failure's notice unchanged", async (context) => {
    const t = await toaster(context);
    await t.show({
      id: 't8-success-failed',
      error: failure({ code: 'not_found', message: 'Gone.' }),
    });

    await act(() => {
      sonner.toast.success('Saved.', { id: 't8-success' });
    });
    await t.advance(0);

    assert.equal(t.surfaces().length, 1);
    assert.equal(titleOf(t.notice()).textContent, 'Not found');
    assert.equal(explanationOf(t.notice())?.textContent, 'Gone.');
  });
});

/* ------------------------------------------------------------------ */
/* T-36: announcement                                                  */
/* ------------------------------------------------------------------ */

describe('the announcement of a failure (T-36)', () => {
  test('is an alert the first time the window shows the error and a group on remount', async () => {
    const error = fresh();

    const first = await mount({ error, announce: true });
    assert.equal(first.notice().getAttribute('role'), 'alert');
    await first.unmount();

    const second = await mount({ error, announce: true });
    assert.equal(second.notice().getAttribute('role'), 'group');
    await second.unmount();
  });

  test('is an alert again for the same error at another time', async () => {
    const error = fresh();
    const first = await mount({ error, announce: true });
    await first.unmount();

    const later = await mount({
      error: { ...error, at: '2026-11-16T12:05:00.000Z' },
      announce: true,
    });

    assert.equal(later.notice().getAttribute('role'), 'alert');
    await later.unmount();
  });

  test('is an alert again for the same error with other context', async () => {
    const error = fresh();
    const first = await mount({
      error,
      announce: true,
      context: { Thread: 'a' },
    });
    await first.unmount();

    const other = await mount({
      error,
      announce: true,
      context: { Thread: 'b' },
    });

    assert.equal(other.notice().getAttribute('role'), 'alert');
    await other.unmount();
  });

  test('stays an alert under StrictMode, after commit and after a re-render', async () => {
    const error = fresh();

    const view = await mount({ error, announce: true }, { strict: true });
    assert.equal(view.notice().getAttribute('role'), 'alert');

    await view.rerender({ error, announce: true });
    assert.equal(view.notice().getAttribute('role'), 'alert');
    await view.unmount();
  });

  test('stays an alert across re-renders of a mounted notice', async () => {
    const error = fresh();
    const view = await mount({ error, announce: true });

    await view.rerender({ error, announce: true, className: 'x' });
    await view.rerender({ error: { ...error }, announce: true });

    assert.equal(view.notice().getAttribute('role'), 'alert');
    await view.unmount();
  });

  test('is an alert when a mounted notice is given a new error', async () => {
    const view = await mount({ error: fresh(), announce: true });

    await view.rerender({ error: fresh(), announce: true });

    assert.equal(view.notice().getAttribute('role'), 'alert');
    await view.unmount();
  });

  test('an error with no time is an alert then a group, with no Time line', async () => {
    const { at: _at, ...error } = fresh();

    const first = await mount({ error, announce: true });
    assert.equal(first.notice().getAttribute('role'), 'alert');
    await press(detailsLink(first.notice()));
    assert.ok(!openDetails(first.notice())?.textContent?.includes('Time:'));
    await first.unmount();

    const second = await mount({ error, announce: true });
    assert.equal(second.notice().getAttribute('role'), 'group');
    await second.unmount();
  });

  test('a notice without announce is never an alert', async () => {
    const view = await mount({ error: fresh() });

    assert.equal(view.notice().getAttribute('role'), 'group');
    await view.unmount();
  });
});
