/**
 * `ReadFeedback` turns a read failure into the app's recoverable toast: one
 * toast per surface by default, one shared toast for surfaces that pass the
 * same fixed `toastId` (the files and changes panel items), and no toast once
 * the read succeeds again.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { Window } from 'happy-dom';

const window = new Window();
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Element',
  'Event',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

type Feedback = typeof import('desktop-ui/workspace').ReadFeedback;
type Toast = typeof import('desktop-ui/sonner').toast;

let ReadFeedback: Feedback;
let toast: Toast;
let createRoot: typeof import('react-dom/client').createRoot;
let act: (callback: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import('react').createElement;
let Fragment: typeof import('react').Fragment;

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (window as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import('react');
  act = react.act as typeof act;
  createElement = react.createElement;
  Fragment = react.Fragment;
  ({ createRoot } = await import('react-dom/client'));
  ({ ReadFeedback } = await import('desktop-ui/workspace'));
  ({ toast } = await import('desktop-ui/sonner'));
});

after(async () => {
  await window.happyDOM.close();
});

/** The error toasts still on screen, by id and description. */
const shown = () =>
  toast.getToasts().map((entry) => ({
    id: entry.id,
    title: 'title' in entry ? entry.title : undefined,
    description: 'description' in entry ? entry.description : undefined,
  }));

type Surface = { readonly error?: string; readonly toastId?: string };

const mount = () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  const render = (surfaces: readonly Surface[]) =>
    act(() => {
      root.render(
        createElement(
          Fragment,
          null,
          ...surfaces.map((surface, index) =>
            createElement(ReadFeedback, {
              key: index,
              error: surface.error,
              refreshing: false,
              onRetry: () => undefined,
              toastId: surface.toastId,
            }),
          ),
        ),
      );
    });
  return {
    render,
    unmount: () => act(() => root.unmount()),
  };
};

describe('ReadFeedback', () => {
  beforeEach(() => {
    toast.dismiss();
  });

  test('gives each surface its own toast when no id is fixed', async () => {
    const view = mount();
    await view.render([
      { error: 'Tree failed.' },
      { error: 'Changes failed.' },
    ]);
    const toasts = shown();
    assert.equal(toasts.length, 2);
    assert.notEqual(toasts[0]?.id, toasts[1]?.id);
    assert.deepEqual(
      toasts
        .map(({ title, description }) => ({ title, description }))
        .sort((a, b) =>
          String(a.description).localeCompare(String(b.description)),
        ),
      [
        { title: 'Unable to update', description: 'Changes failed.' },
        { title: 'Unable to update', description: 'Tree failed.' },
      ],
    );
    await view.unmount();
  });

  test('surfaces sharing a fixed id show one toast under that id', async () => {
    const view = mount();
    await view.render([
      { error: 'Tree failed.', toastId: 'project-files' },
      { error: 'Tree failed.', toastId: 'project-files' },
    ]);
    assert.deepEqual(shown(), [
      {
        id: 'project-files',
        title: 'Unable to update',
        description: 'Tree failed.',
      },
    ]);
    await view.unmount();
  });

  test('a read that succeeds again dismisses its toast', async () => {
    const view = mount();
    await view.render([{ error: 'Tree failed.', toastId: 'project-files' }]);
    assert.equal(shown().length, 1);
    await view.render([{ toastId: 'project-files' }]);
    assert.deepEqual(shown(), []);
    await view.unmount();
  });
});
