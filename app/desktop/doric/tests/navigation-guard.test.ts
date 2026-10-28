// P7 for an app window, without Electron: the main frame stays where it is,
// and a subframe — a preview frame — may only be at the frame document,
// whoever started its navigation.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type GuardedAppContents,
  installNavigationGuard,
} from '../src/platform/windows/navigation-guard';

const SHELL_URL = 'doric://app/projects/p1';

/** Fake web contents: emits Electron's navigation events at the guard. */
const guarded = () => {
  const listeners = new Map<string, (...args: never[]) => void>();
  const contents = {
    getURL: () => SHELL_URL,
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
    },
    setWindowOpenHandler: () => undefined,
  } as unknown as GuardedAppContents;

  installNavigationGuard(contents);

  const prevented = (event: string, ...args: unknown[]): boolean => {
    let prevented = false;
    const preventDefault = () => {
      prevented = true;
    };
    const listener = listeners.get(event) as (...args: unknown[]) => void;

    if (event === 'will-navigate') {
      listener({ preventDefault }, ...args);
    } else {
      listener({ ...(args[0] as object), preventDefault });
    }

    return prevented;
  };

  return {
    /** Whether the guard refused a subframe navigation to `url`. */
    subframe: (url: string) =>
      prevented('will-frame-navigate', { url, isMainFrame: false }),
    mainFrame: (url: string) =>
      prevented('will-frame-navigate', { url, isMainFrame: true }) ||
      prevented('will-navigate', url),
  };
};

describe('an app window guards its subframes', () => {
  test('a subframe may load the frame document, whatever its entry', () => {
    const guard = guarded();

    for (const url of [
      'doric://app/frame/index.html',
      'doric://app/frame/index.html?entry=doric%3A%2F%2Fapp%2Fbundles%2Fpapercraft%401.0.0%2Fclient%2Fframes%2Fpreview.js',
    ]) {
      assert.equal(guard.subframe(url), false, url);
    }
  });

  test('any other subframe navigation is refused', () => {
    const guard = guarded();

    for (const url of [
      SHELL_URL,
      'doric://app/',
      'doric://app/frame/boot.js',
      'doric://app/frame/',
      'doric://app/frame/index.html/x',
      'doric://app/artifacts/checkout-7f3a@1/index.js',
      'doric://app/bundles/papercraft@1.0.0/client/frames/preview.js',
      'doric://other/frame/index.html',
      'https://example.com/frame/index.html',
      'http://localhost:4200/',
      'file:///etc/passwd',
      'data:text/html,<p>x</p>',
      'javascript:alert(1)',
      'not a url',
    ]) {
      assert.equal(guard.subframe(url), true, url);
    }
  });

  test('the main frame keeps its own rule: it stays at its URL', () => {
    const guard = guarded();

    assert.equal(guard.mainFrame(SHELL_URL), false);
    assert.equal(guard.mainFrame('doric://app/frame/index.html'), true);
    assert.equal(guard.mainFrame('https://example.com/'), true);
  });
});
