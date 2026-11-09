// The Changes view rendered in happy-dom over the stories' fakes: the git
// store over a fake `GitApi`, the layout's selection and the files tree read
// the view is gated by. Smoke test of the client test setup (Part 4.4b).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { type Rendered, render } from './support/render.js';

let rendered: Rendered | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
});

test('the Changes view lists the changed files the host answers', async () => {
  let asked = 0;
  rendered = await render(async () => {
    const { createElement } = await import('react');
    const { GitChangesView } = await import(
      '../../src/client/changes/git-changes.js'
    );
    const { fakeGitApi, GitHarness, readyTree, windowServices } = await import(
      '../../stories/support/git-harness.js'
    );
    const { changes } = await import('../../stories/support/fixtures.js');
    const api = fakeGitApi({
      changes: async () => {
        asked += 1;
        return { status: 'ready', changes };
      },
    });
    return createElement(
      GitHarness,
      { api },
      createElement(GitChangesView, {
        services: windowServices({ tree: readyTree }),
      }),
    );
  });

  assert.ok(asked > 0, 'the view asked the host for the changes');
  const text = rendered.root.textContent ?? '';
  for (const name of ['Checkout.tsx', 'pricing.ts', 'checkout-flow.md']) {
    assert.ok(text.includes(name), `${name} is listed`);
  }
});
