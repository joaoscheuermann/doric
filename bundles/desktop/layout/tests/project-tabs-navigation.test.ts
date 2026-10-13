import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Services } from 'bundle/contracts';
import { Window } from 'happy-dom';
import { createElement } from 'react';

import { useProjectTabs } from '../src/client/hooks/use-project-tabs.js';
import { setLayoutServices } from '../src/client/services/layout-services.js';

test('project tabs keep one navigation subscription across renders and release it on unmount', async () => {
  const window = new Window();
  Object.assign(globalThis, {
    window,
    document: window.document,
    localStorage: window.localStorage,
  });
  const { createRoot } = await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  let path = '/projects/p1';
  let subscriptions = 0;
  let disposals = 0;
  const listeners = new Set<() => void>();
  const errors: unknown[] = [];
  setLayoutServices({
    use: () => ({
      current: () => ({ path }),
      subscribe: (listener: () => void) => {
        subscriptions += 1;
        if (subscriptions > 100) throw new Error('navigation does not settle');
        listeners.add(listener);
        return {
          dispose: () => {
            disposals += 1;
            listeners.delete(listener);
          },
        };
      },
    }),
  } as unknown as Services);
  const root = createRoot(window.document.body as unknown as HTMLElement, {
    onUncaughtError: (error) => errors.push(error),
  });
  const projects: never[] = [];
  const Probe = () => {
    const tabs = useProjectTabs(projects, false);
    return createElement('span', null, tabs.path);
  };
  try {
    for (let i = 0; i < 30; i += 1) {
      flushSync(() => root.render(createElement(Probe)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(errors, []);
    assert.equal(subscriptions, 1);
    path = '/projects/p2';
    flushSync(() => {
      for (const listener of listeners) listener();
    });
    assert.equal(window.document.body.textContent, path);
    assert.equal(subscriptions, 1);
  } finally {
    root.unmount();
    setLayoutServices(undefined);
    await window.happyDOM.close();
  }
  assert.equal(disposals, 1);
  assert.equal(listeners.size, 0);
});
