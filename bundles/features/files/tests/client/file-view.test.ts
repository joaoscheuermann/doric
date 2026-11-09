// A file tab whose path is no longer in the workspace (§4.4 A6, T-4.4.1): the
// git bundle's "Open file" opens a deleted file's tab through
// `files.open-file/v1`, and the tab says the file cannot be shown, with the
// reason, instead of its text. The view runs over the stories' services, with
// `files/v1.content` answering `not_found` as the host does for a missing path.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { type Rendered, render, settle } from './support/render.js';

let rendered: Rendered | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const DELETED = 'apps/web/src/checkout/payment-form.tsx';

/** What `files/v1.content` was asked, by Project. */
type ContentCall = { readonly projectId?: string; readonly path: unknown };

const renderFileTab = async (
  content: (input: { readonly path: string }) => unknown,
): Promise<{ readonly view: Rendered; readonly calls: ContentCall[] }> => {
  const calls: ContentCall[] = [];
  const view = await render(async () => {
    const { createElement } = await import('react');
    const { QueryClient, QueryClientProvider } = await import(
      '@tanstack/react-query'
    );
    const { FileView } = await import('../../src/client/file/file-view.js');
    const { storyServices } = await import('../../stories/support/services.js');
    const services = storyServices({
      scoped: {
        'files/v1': (scope) => ({
          content: async (input: { readonly path: string }) => {
            calls.push({ projectId: scope?.projectId, path: input.path });
            return content(input);
          },
        }),
      },
    });
    return createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(FileView, {
        services,
        projectId: PROJECT_ID,
        path: DELETED,
      }),
    );
  });
  rendered = view;
  await settle();
  return { view, calls };
};

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

test('a file tab whose path no longer exists says the file cannot be shown and why', async () => {
  const { view, calls } = await renderFileTab(() => ({
    status: 'ready',
    value: { status: 'not_found' },
  }));
  const text = normalized(view.root.textContent);

  assert.deepEqual(calls, [{ projectId: PROJECT_ID, path: DELETED }]);
  assert.match(text, /This file cannot be shown/);
  assert.match(text, /That path is no longer in the workspace\./);
  // The footer still names the path the tab was opened for.
  assert.match(text, new RegExp(DELETED.replaceAll('.', '\\.')));
});

// The control: a path that is still there is read and drawn, not refused. A
// binary file keeps the code editor (Monaco, which node cannot load) out.
test('a file tab whose path exists shows the file, not the not-found view', async () => {
  const { view } = await renderFileTab(({ path }) => ({
    status: 'ready',
    value: {
      status: 'read',
      path,
      content: '',
      truncated: false,
      binary: true,
    },
  }));
  const text = normalized(view.root.textContent);

  assert.match(text, /This is a binary file, so its contents are not shown\./);
  assert.doesNotMatch(text, /This file cannot be shown/);
});
