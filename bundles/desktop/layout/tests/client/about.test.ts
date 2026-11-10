// The app version the account menu shows, as `useAboutVersion` reads it
// while `followAbout` follows `doric.about/v1` (S35, coordinator decision 1):
// an answer becomes the version, disposing clears it, and an answer that
// resolves after its provider's cleanup or after `dispose` is dropped.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import type { Services } from 'bundle/contracts';
import { Window } from 'happy-dom';

import * as about from '../../src/client/domain/about.js';

let shown: () => string;

before(async () => {
  const window = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    window,
    document: window.document,
    localStorage: window.localStorage,
  });
  const { createElement } = await import('react');
  const { flushSync } = await import('react-dom');
  const { createRoot } = await import('react-dom/client');

  const element = window.document.createElement('div');
  window.document.body.append(element as never);
  const root = createRoot(element as unknown as HTMLElement);
  const Version = () =>
    createElement('span', null, about.useAboutVersion() ?? 'none');
  flushSync(() => root.render(createElement(Version)));
  shown = () => element.textContent ?? '';
});

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
};

/** An answer the test resolves when it chooses. */
const deferred = () => {
  let resolve: (value: { readonly version: string }) => void = () => {};
  const promise = new Promise<{ readonly version: string }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/**
 * Services with one `doric.about/v1` provider whose `get()` answers
 * `answer`. `leave()` runs the cleanup the `whenAvailable` callback
 * returned, as the runtime does when the provider goes; disposing the
 * `whenAvailable` runs it too, once, as the runtime does.
 */
const servicesWith = (answer: Promise<{ readonly version: string }>) => {
  let cleanup: unknown;
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    if (typeof cleanup === 'function') (cleanup as () => void)();
  };
  const services = {
    use: () => {
      throw new Error('doric.about/v1 is followed, never used.');
    },
    provide: () => ({ dispose: () => undefined }),
    whenAvailable: (
      contract: { readonly id: string },
      callback: (api: unknown, provider: unknown) => unknown,
    ) => {
      if (contract.id === 'doric.about/v1') {
        cleanup = callback(
          { get: () => answer },
          { bundleId: 'doric', version: '1.2.0' },
        );
      }
      return { dispose: leave };
    },
  } as unknown as Services;
  return { services, leave };
};

test("the provider's answer becomes the version, and disposing clears it", async () => {
  const { services } = servicesWith(Promise.resolve({ version: '9.9.9' }));

  const following = about.followAbout(services);
  await settle();
  assert.equal(shown(), '9.9.9');

  following.dispose();
  await settle();
  assert.equal(shown(), 'none');
});

test('an answer that resolves after dispose is dropped', async () => {
  const answer = deferred();
  const { services } = servicesWith(answer.promise);

  const following = about.followAbout(services);
  following.dispose();
  answer.resolve({ version: '9.9.9' });
  await settle();

  assert.equal(shown(), 'none');
});

test("an answer that resolves after its provider's cleanup is dropped", async () => {
  const answer = deferred();
  const { services, leave } = servicesWith(answer.promise);

  const following = about.followAbout(services);
  leave();
  answer.resolve({ version: '9.9.9' });
  await settle();

  assert.equal(shown(), 'none');
  following.dispose();
});
