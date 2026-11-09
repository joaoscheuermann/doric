// The terminal's ◆ entries (§4.4, T-4.4.1 for A7 and A13–A15, T-4.4.6,
// T-4.4.7 client part), as the reader meets them:
// - a terminal record keeps its name (terminal/v1@1.2.0) and is named by it on
//   its row and tab, else by its command;
// - the terminal tab's menu holds Kill terminal (A7, destructive); the tab's
//   Close tab (layout) leaves the process running, Kill terminal ends it;
// - each session update retitles the terminal's tab with its name, or its
//   command once the name is cleared;
// - the row's menu holds Rename (A13), Copy command (A14) and Kill terminal
//   (A15); Rename edits the name inline, at most 80 characters.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  createTerminalApi,
  type TerminalHost,
  terminalApiMessages,
  terminalFrom,
} from '../../src/client/api.js';
import {
  type Terminal,
  type TerminalUpdate,
  terminalLabel,
} from '../../src/client/domain/terminals.js';
import { createTerminalStore } from '../../src/client/store.js';
import { terminalTab } from '../../src/client/tab.js';
import type { TerminalSession } from '../../src/contracts/index.js';
import { type Rendered, render, settle } from './support/render.js';

const session = (
  overrides: Partial<TerminalSession> = {},
): TerminalSession => ({
  id: 'terminal-1',
  projectId: 'project-1',
  threadId: 'thread-1',
  origin: 'user',
  command: 'bash',
  cwd: '/workspace',
  startedAt: '2026-11-09T10:00:00.000Z',
  timeoutMs: null,
  state: 'running',
  pty: true,
  ...overrides,
});

/** A terminal/v1 host that records each call. */
const fakeHost = (overrides: Partial<TerminalHost> = {}) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <A extends unknown[], R>(method: string, answer: (...args: A) => R) =>
    (...args: A): R => {
      calls.push({ method, args });
      return answer(...args);
    };
  const host: TerminalHost = {
    list: record('list', async () => []),
    create: record('create', async () => session()),
    snapshot: record('snapshot', async () => ({
      terminal: session(),
      output: '',
      offset: 0,
      truncated: false,
    })),
    input: record('input', async () => true),
    resize: record('resize', async () => true),
    stop: record('stop', async () => true),
    rename: record('rename', async () => true),
    ...overrides,
  };
  return { host, calls };
};

const storeOver = (host: TerminalHost) => {
  const toasts: string[] = [];
  const retitled: { id: string; title: string; threadId: string }[] = [];
  const listeners = new Map<string, (update: TerminalUpdate) => void>();
  const store = createTerminalStore({
    api: createTerminalApi(() => host),
    openTerminal: async () => undefined,
    watchProject: (projectId, listener) => {
      listeners.set(projectId, listener);
      return () => listeners.delete(projectId);
    },
    toastError: (message) => toasts.push(message),
    closeTab: () => undefined,
    retitleTab: (input) => retitled.push(input),
    refreshFiles: () => undefined,
  });
  return {
    store,
    toasts,
    retitled,
    emit: (update: TerminalUpdate) => listeners.get('project-1')?.(update),
  };
};

void describe('a terminal name (terminal/v1@1.2.0)', () => {
  test('terminalFrom keeps a string name and leaves it out when absent', () => {
    assert.equal(
      terminalFrom(session({ name: 'Dev server' })).name,
      'Dev server',
    );
    assert.equal(Object.hasOwn(terminalFrom(session()), 'name'), false);
  });

  test('terminalFrom rejects a name that is not a string', () => {
    for (const name of [42, null, {}, ['x']]) {
      assert.throws(() => terminalFrom({ ...session(), name }), {
        message: terminalApiMessages.invalidTerminal,
      });
    }
  });

  test('a row is labelled by the name, else by the command', () => {
    const now = Date.parse('2026-11-09T10:01:23.000Z');
    assert.equal(terminalLabel(terminalFrom(session()), now), 'bash');
    assert.equal(
      terminalLabel(terminalFrom(session({ name: 'Dev server' })), now),
      'Dev server',
    );
    assert.equal(
      terminalLabel(
        terminalFrom(
          session({ origin: 'agent', command: 'npm run dev', name: 'Web' }),
        ),
        now,
      ),
      'Web · 01:23 (no limit)',
    );
  });

  test('rename sends the id and the name and answers the host', async () => {
    const refusing = createTerminalApi(
      () => fakeHost({ rename: async () => false }).host,
    );
    assert.equal(await refusing.rename('terminal-1', 'Dev server'), false);
    const recorded = fakeHost();
    const recording = createTerminalApi(() => recorded.host);
    assert.equal(await recording.rename('terminal-1', null), true);
    assert.deepEqual(recorded.calls, [
      { method: 'rename', args: ['terminal-1', null] },
    ]);
    const failing = createTerminalApi(
      () =>
        fakeHost({
          rename: async () => {
            throw new Error('boom');
          },
        }).host,
    );
    await assert.rejects(failing.rename('terminal-1', 'x'), {
      message: terminalApiMessages.terminalFailed,
    });
  });
});

void describe('the terminal tab (A7, T-4.4.6, T-4.4.7)', () => {
  test('opens titled by the name, else by the command, else "Terminal"', () => {
    const kill = () => undefined;
    assert.equal(
      terminalTab(terminalFrom(session({ name: 'Dev server' })), kill).title,
      'Dev server',
    );
    assert.equal(terminalTab(terminalFrom(session()), kill).title, 'bash');
    assert.equal(
      terminalTab(terminalFrom(session({ command: '' })), kill).title,
      'Terminal',
    );
  });

  test('its menu holds Kill terminal, destructive', () => {
    const tab = terminalTab(terminalFrom(session()), () => undefined);
    assert.equal(tab.id, 'terminal:terminal-1');
    assert.deepEqual(
      tab.menu?.map(({ label, destructive }) => ({ label, destructive })),
      [{ label: 'Kill terminal', destructive: true }],
    );
  });

  test('Close tab leaves the process running; Kill terminal ends it', async () => {
    const { host, calls } = fakeHost();
    const { store } = storeOver(host);
    const tab = terminalTab(terminalFrom(session()), store.stop);
    // Opening and closing the tab are the layout's: nothing reaches the
    // terminal's process until Kill terminal runs.
    await settle();
    assert.deepEqual(
      calls.filter(({ method }) => method === 'stop'),
      [],
    );
    tab.menu?.find(({ label }) => label === 'Kill terminal')?.run();
    await settle();
    assert.deepEqual(
      calls.filter(({ method }) => method === 'stop'),
      [{ method: 'stop', args: ['terminal-1'] }],
    );
  });

  test('an update retitles the tab with the name, then with the command once cleared', () => {
    const f = storeOver(fakeHost().host);
    f.store.follow('project-1');
    f.emit({ kind: 'snapshot', terminals: [terminalFrom(session())] });
    f.emit({
      kind: 'updated',
      terminal: terminalFrom(session({ name: 'Dev server' })),
    });
    f.emit({ kind: 'updated', terminal: terminalFrom(session()) });
    assert.deepEqual(f.retitled, [
      { id: 'terminal:terminal-1', title: 'Dev server', threadId: 'thread-1' },
      { id: 'terminal:terminal-1', title: 'bash', threadId: 'thread-1' },
    ]);
  });

  test('a rename the host refuses or fails is a toast and resolves', async () => {
    const answered = fakeHost();
    const ok = storeOver(answered.host);
    await ok.store.rename('terminal-1', 'Dev server');
    assert.deepEqual(answered.calls, [
      { method: 'rename', args: ['terminal-1', 'Dev server'] },
    ]);
    assert.deepEqual(ok.toasts, []);
    const failing = storeOver(
      fakeHost({
        rename: async () => {
          throw new Error('boom');
        },
      }).host,
    );
    await failing.store.rename('terminal-1', 'Dev server');
    assert.deepEqual(failing.toasts, [terminalApiMessages.terminalFailed]);
  });
});

void describe('the terminal row menu (A13–A15)', () => {
  let rendered: Rendered | undefined;

  afterEach(() => {
    rendered?.cleanup();
    rendered = undefined;
    document.body.replaceChildren();
  });

  const shell = terminalFrom(session({ id: 'shell', command: 'npm run dev' }));

  const renderRows = async (
    terminals: readonly Terminal[],
    handlers: {
      onStop?: (id: string) => void;
      onRename?: (id: string, name: string | null) => Promise<void>;
      onError?: (message: string) => void;
    } = {},
  ): Promise<Rendered> =>
    render(async () => {
      const { createElement } = await import('react');
      const { SidebarMenu, SidebarScope } = await import('desktop/ui/sidebar');
      const { TerminalRows } = await import(
        '../../src/client/rows/terminal-rows.js'
      );
      return createElement(
        SidebarScope,
        null,
        createElement(
          SidebarMenu,
          null,
          createElement(TerminalRows, { terminals, depth: 1, ...handlers }),
        ),
      );
    });

  const row = (root: HTMLElement): HTMLElement => {
    const button = root.querySelector<HTMLElement>(
      'li button:not([aria-label])',
    );
    assert.ok(button, 'No terminal row.');
    return button;
  };

  const openMenu = async (target: Element): Promise<void> => {
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    await settle();
  };

  const entries = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="context-menu-content"] [role="menuitem"]',
    ),
  ];

  const pick = async (label: string): Promise<void> => {
    const entry = entries().find((item) => item.textContent?.trim() === label);
    assert.ok(entry, `No "${label}" in the menu.`);
    entry.click();
    await settle();
  };

  const nameField = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Terminal name"]',
    );

  const type = async (value: string, key: string): Promise<void> => {
    const field = nameField();
    assert.ok(field, 'No Terminal name field.');
    const { act } = await import('react');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setter?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    });
    await settle();
  };

  test('a named terminal shows its name on its row', async () => {
    rendered = await renderRows([{ ...shell, name: 'Dev server' }]);
    assert.equal(row(rendered.root).textContent?.trim(), 'Dev server');
  });

  test('the row menu holds Rename, Copy command and Kill terminal, the last destructive', async () => {
    rendered = await renderRows([shell], {
      onStop: () => undefined,
      onRename: async () => undefined,
    });
    await openMenu(row(rendered.root));
    assert.deepEqual(
      entries().map((entry) => entry.textContent?.trim()),
      ['Rename', 'Copy command', 'Kill terminal'],
    );
    assert.equal(entries().at(-1)?.dataset.variant, 'destructive');
  });

  test('A15: Kill terminal stops the terminal', async () => {
    const stopped: string[] = [];
    rendered = await renderRows([shell], {
      onStop: (id) => stopped.push(id),
    });
    await openMenu(row(rendered.root));
    await pick('Kill terminal');
    assert.deepEqual(stopped, ['shell']);
  });

  test('A14: Copy command puts the command on the clipboard', async () => {
    rendered = await renderRows([{ ...shell, name: 'Dev server' }]);
    await openMenu(row(rendered.root));
    await pick('Copy command');
    assert.equal(await navigator.clipboard.readText(), 'npm run dev');
  });

  test('A13: Rename sends the trimmed name with Enter and closes the field', async () => {
    const renamed: [string, string | null][] = [];
    rendered = await renderRows([shell], {
      onRename: async (id, name) => {
        renamed.push([id, name]);
      },
    });
    await openMenu(row(rendered.root));
    await pick('Rename');
    const field = nameField();
    assert.ok(field, 'No Terminal name field.');
    assert.equal(field.maxLength, 80);
    await type('  Dev server  ', 'Enter');
    assert.deepEqual(renamed, [['shell', 'Dev server']]);
    assert.equal(nameField(), null);
  });

  test('A13: an empty or whitespace-only name clears it', async () => {
    const renamed: [string, string | null][] = [];
    rendered = await renderRows([{ ...shell, name: 'Dev server' }], {
      onRename: async (id, name) => {
        renamed.push([id, name]);
      },
    });
    await openMenu(row(rendered.root));
    await pick('Rename');
    await type('   ', 'Enter');
    assert.deepEqual(renamed, [['shell', null]]);
  });

  test('A13: Escape closes the field and sends nothing', async () => {
    const renamed: [string, string | null][] = [];
    rendered = await renderRows([shell], {
      onRename: async (id, name) => {
        renamed.push([id, name]);
      },
    });
    await openMenu(row(rendered.root));
    await pick('Rename');
    await type('Dev server', 'Escape');
    assert.deepEqual(renamed, []);
    assert.equal(nameField(), null);
    assert.equal(row(rendered.root).textContent?.trim(), 'npm run dev');
  });

  test('A13: a rename that fails closes the field and keeps the old name', async () => {
    rendered = await renderRows([{ ...shell, name: 'Old' }], {
      onRename: async () => {
        throw new Error('boom');
      },
    });
    await openMenu(row(rendered.root));
    await pick('Rename');
    await type('New', 'Enter');
    assert.equal(nameField(), null);
    assert.equal(row(rendered.root).textContent?.trim(), 'Old');
    assert.deepEqual(rendered.errors(), []);
  });
});
