import assert from 'node:assert/strict';
import test from 'node:test';

import { LogV1 } from 'bundle/contracts';
import { traceIdOf } from 'bundle/runtime';

import { bootDesktop, probe } from '../support/desktop.js';

const workspaceAppearance = {
  size: { width: 1280, height: 800, minWidth: 960, minHeight: 640 },
  titleBar: 'integrated',
  background: 'window',
};

/** Electron's default application menu, one role per top-level menu. */
const electronDefaultMenu = [
  { id: 'app', label: 'App', role: 'appMenu' },
  { id: 'file', label: 'File', role: 'fileMenu' },
  { id: 'edit', label: 'Edit', role: 'editMenu' },
  { id: 'view', label: 'View', role: 'viewMenu' },
  { id: 'window', label: 'Window', role: 'windowMenu' },
  { id: 'help', label: 'Help', role: 'help' },
];

void test('the built core activates in desktopMain without touching main until the app is ready', async () => {
  const desktop = await bootDesktop([]);

  try {
    assert.equal(desktop.states.core, 'active');
    assert.deepEqual(desktop.calls, []);
  } finally {
    await desktop.stop();
  }
});

void test('onAppReadyHook sets the default menu, then opens the workspace window at "/" the first time', async () => {
  const desktop = await bootDesktop([]);

  try {
    const call = desktop.call();

    await desktop.fire('onAppReadyHook', call);

    const [skeleton, ...rest] = desktop.calls.filter(
      ({ method }) =>
        method !== 'doric.windows/v1.lastPath' &&
        method !== 'doric.migrations/v1.storage',
    );

    assert.equal(skeleton?.method, 'doric.menus/v1.setSkeleton');
    assert.deepEqual(skeleton?.input, electronDefaultMenu);
    assert.deepEqual(
      rest.map(({ method, input }) => ({ method, input })),
      [
        {
          method: 'doric.windows/v1.open',
          input: {
            key: 'workspace',
            path: '/',
            appearance: workspaceAppearance,
            primary: true,
          },
        },
      ],
    );
    // The hook's call is passed on: the broker sees the same trace.
    assert.equal(
      traceIdOf((rest[0]?.call ?? call).trace),
      traceIdOf(call.trace),
    );
  } finally {
    await desktop.stop();
  }
});

void test('onAppReadyHook hands the saved selection to the platform migration, before the primary window opens', async () => {
  const desktop = await bootDesktop([]);

  try {
    await desktop.fire('onAppReadyHook');

    assert.deepEqual(
      desktop.received('doric.migrations/v1.storage').map(({ input }) => input),
      [{ key: 'doric.selection', marker: 'selectionOrigin' }],
    );

    const methods = desktop.calls.map(({ method }) => method);

    assert.ok(
      methods.indexOf('doric.migrations/v1.storage') <
        methods.indexOf('doric.windows/v1.open'),
    );
  } finally {
    await desktop.stop();
  }
});

void test('a migration the platform cannot run is logged, and the primary window still opens', async () => {
  const desktop = await bootDesktop([], { storageMigrationFails: true });

  try {
    await desktop.fire('onAppReadyHook');

    assert.deepEqual(
      desktop
        .received('doric.windows/v1.open')
        .map(({ input }) => (input as { readonly key: string }).key),
      ['workspace'],
    );
    assert.ok(
      desktop.records.some(
        ({ message, fields }) =>
          message === 'Selection migration did not run' &&
          fields?.marker === 'selectionOrigin',
      ),
    );
  } finally {
    await desktop.stop();
  }
});

void test('onAppReadyHook reopens the workspace at the path main remembered for it', async () => {
  const desktop = await bootDesktop([], {
    lastPaths: { workspace: '/projects/p1/threads/t1' },
  });

  try {
    await desktop.fire('onAppReadyHook');

    assert.deepEqual(
      desktop.received('doric.windows/v1.open').map(({ input }) => input),
      [
        {
          key: 'workspace',
          path: '/projects/p1/threads/t1',
          appearance: workspaceAppearance,
          primary: true,
        },
      ],
    );
  } finally {
    await desktop.stop();
  }
});

void test('onAppActivateHook focuses the workspace window, or opens it when it is gone', async () => {
  const desktop = await bootDesktop([]);

  try {
    await desktop.fire('onAppActivateHook');

    assert.deepEqual(
      desktop.calls.map(({ method, input }) => ({ method, input })),
      [{ method: 'doric.windows/v1.focusOrOpen', input: 'workspace' }],
    );
  } finally {
    await desktop.stop();
  }
});

void test('log/v1 records of a desktopMain bundle reach the platform log, naming the bundle and the environment', async () => {
  const desktop = await bootDesktop([
    probe('graph', {
      requires: ['log/v1@^1.0.0'],
      activate: async ({ services }) => {
        await services.use(LogV1).info('graph ready', { nodes: 3 });
      },
    }),
  ]);

  try {
    assert.deepEqual(
      desktop.records.map(
        ({ level, message, fields, bundleId, environment }) => ({
          level,
          message,
          fields,
          bundleId,
          environment,
        }),
      ),
      [
        {
          level: 'info',
          message: 'graph ready',
          fields: { nodes: 3 },
          bundleId: 'graph',
          environment: 'desktopMain',
        },
      ],
    );
  } finally {
    await desktop.stop();
  }
});
