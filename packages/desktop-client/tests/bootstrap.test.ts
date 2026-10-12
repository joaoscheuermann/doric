import assert from 'node:assert/strict';
import test from 'node:test';

import { commandsMethods, defineMethod, defineService } from 'bundle/contracts';

import { bootstrapWindow } from '../src/index.js';
import {
  asDocument,
  type ClientBundle,
  chrome,
  describe,
  fakeDesktop,
  fakeDocument,
  fakeKeyTarget,
  importerOf,
  settle,
  windowCatalog,
} from './support/fixtures.js';

const run = async (
  bundles: readonly ClientBundle[],
  options: {
    readonly key?: string;
    readonly primary?: boolean;
    readonly describeError?: Error;
    readonly mount?: () => void | Promise<void>;
  } = {},
) => {
  const description = describe({
    key: options.key ?? 'workspace',
    primary: options.primary ?? true,
  });
  const desktop = fakeDesktop(
    description,
    windowCatalog(bundles, { core: 'core' }),
    options.describeError === undefined
      ? {}
      : { describeError: options.describeError },
  );
  const document = fakeDocument();
  const mounted: unknown[] = [];

  await bootstrapWindow({
    desktop,
    document: asDocument(document),
    importPart: importerOf(bundles),
    keyTarget: fakeKeyTarget(),
    mount: async (context) => {
      desktop.steps.push('mount');
      mounted.push(context.description);
      await options.mount?.();
    },
  });

  return { desktop, document, mounted, description };
};

void test('a window bootstraps in order and reports ready after the mount', async () => {
  const { desktop, mounted, description } = await run([
    { id: 'core', activate: () => undefined },
  ]);

  assert.deepEqual(desktop.steps, [
    'describeWindow',
    'catalog',
    'mount',
    'ready',
  ]);
  assert.deepEqual(mounted, [description]);
});

void test('the chrome becomes CSS variables and follows chrome changes', async () => {
  const { desktop, document } = await run([
    { id: 'core', activate: () => undefined },
  ]);
  const values = document.documentElement.style.values;

  assert.deepEqual(Object.fromEntries(values), {
    '--doric-titlebar-height': '36px',
    '--doric-safe-top': '0px',
    '--doric-safe-left': '80px',
    '--doric-safe-right': '0px',
  });

  desktop.changeChrome({ ...chrome, safeArea: { top: 4, left: 0, right: 12 } });

  assert.equal(values.get('--doric-safe-top'), '4px');
  assert.equal(values.get('--doric-safe-left'), '0px');
  assert.equal(values.get('--doric-safe-right'), '12px');
});

void test('a quarantined core in the workspace window reports a core failure instead of ready', async () => {
  const { desktop } = await run([
    {
      id: 'core',
      activate: () => {
        throw new Error('core client failed');
      },
    },
  ]);

  assert.equal(desktop.steps.includes('ready'), false);
  assert.deepEqual(desktop.failures, [
    { kind: 'core', bundleId: 'core', message: 'core client failed' },
  ]);
});

void test('a quarantined core outside the primary window still reports ready', async () => {
  const { desktop } = await run(
    [
      {
        id: 'core',
        activate: () => {
          throw new Error('core client failed');
        },
      },
    ],
    { key: 'settings', primary: false },
  );

  assert.deepEqual(desktop.failures, []);
  assert.equal(desktop.steps.at(-1), 'ready');
});

void test('the primary flag decides the core failure, not the window key', async () => {
  const failing: ClientBundle[] = [
    {
      id: 'core',
      activate: () => {
        throw new Error('core client failed');
      },
    },
  ];

  const primaryElsewhere = await run(failing, { key: 'main', primary: true });

  assert.deepEqual(primaryElsewhere.desktop.failures, [
    { kind: 'core', bundleId: 'core', message: 'core client failed' },
  ]);
  assert.equal(primaryElsewhere.desktop.steps.includes('ready'), false);

  const workspaceNotPrimary = await run(failing, {
    key: 'workspace',
    primary: false,
  });

  assert.deepEqual(workspaceNotPrimary.desktop.failures, []);
  assert.equal(workspaceNotPrimary.desktop.steps.at(-1), 'ready');
});

void test('a bootstrap error reports a bootstrap failure', async () => {
  const describeFailure = await run([], {
    describeError: new Error('The window is not known.'),
  });

  assert.deepEqual(describeFailure.desktop.failures, [
    { kind: 'bootstrap', message: 'The window is not known.' },
  ]);

  const mountFailure = await run([{ id: 'core', activate: () => undefined }], {
    mount: () => {
      throw new Error('legacy mount failed');
    },
  });

  assert.deepEqual(mountFailure.desktop.failures, [
    { kind: 'bootstrap', message: 'legacy mount failed' },
  ]);
  assert.equal(mountFailure.desktop.steps.includes('ready'), false);
});

// Commands main routes to the window (section 18.3) ---------------------------

const ran: string[] = [];

void test('a command main pushes runs in the window and is answered', async () => {
  ran.length = 0;

  const commands = new Map<string, () => Promise<void>>();
  const provider = defineService('commands/v1', {
    register: defineMethod({
      input: commandsMethods.register.input,
      output: commandsMethods.register.output,
      execute: () => ({ dispose: () => undefined }),
    }),
    execute: defineMethod({
      input: commandsMethods.execute.input,
      output: commandsMethods.execute.output,
      execute: async ([command]) => {
        const run = commands.get(String(command));

        if (run === undefined) {
          throw new Error(`Unknown command ${String(command)}.`);
        }

        await run();
      },
    }),
  });

  commands.set('core.ping/v1', async () => {
    ran.push('core.ping/v1');
  });

  const { desktop } = await run([
    {
      id: 'core',
      provides: ['commands/v1@1.0.0'],
      contracts: [{ id: 'commands/v1', version: '1.0.0' }],
      activate: ({ services }) => {
        services.provide(provider);
      },
    },
  ]);

  desktop.push('doric.shell/v1', 'commands', {
    id: 'c1',
    command: 'core.ping/v1',
    input: {},
  });
  desktop.push('doric.shell/v1', 'commands', {
    id: 'c2',
    command: 'core.missing/v1',
    input: {},
  });
  await settle();

  assert.deepEqual(ran, ['core.ping/v1']);
  const results = desktop.shell('commandResult') as { id: string }[];

  assert.deepEqual(
    [...results].sort((left, right) => left.id.localeCompare(right.id)),
    [
      { id: 'c1', ok: true },
      {
        id: 'c2',
        ok: false,
        error: {
          code: 'internal',
          message: 'Unknown command core.missing/v1.',
        },
      },
    ],
  );
});

void test('without a client commands/v1 provider a pushed command answers unavailable', async () => {
  const { desktop } = await run([{ id: 'core', activate: () => undefined }]);

  desktop.push('doric.shell/v1', 'commands', {
    id: 'c1',
    command: 'core.ping/v1',
    input: {},
  });
  await settle();

  const [result] = desktop.shell('commandResult') as {
    id: string;
    ok: boolean;
    error?: { code: string };
  }[];

  assert.equal(result?.id, 'c1');
  assert.equal(result?.ok, false);
  assert.equal(result?.error?.code, 'unavailable');
});

void test('a client part whose dependency failed is quarantined, the others stay active and the window still reports ready', async () => {
  const activated: string[] = [];
  const { desktop } = await run([
    {
      id: 'core',
      activate: () => {
        activated.push('core');
      },
    },
    {
      id: 'probe-provider',
      provides: ['probe.dep/v1@1.0.0'],
      contracts: [{ id: 'probe.dep/v1', version: '1.0.0' }],
      activate: () => {
        throw new Error('provider exploded');
      },
    },
    {
      id: 'probe-dependent',
      requires: ['probe.dep/v1@^1.0.0'],
      activate: () => {
        activated.push('probe-dependent');
      },
    },
    {
      id: 'healthy',
      activate: () => {
        activated.push('healthy');
      },
    },
  ]);

  await settle();

  assert.deepEqual(activated, ['core', 'healthy']);
  assert.deepEqual(
    desktop
      .shell('diagnostic')
      .filter((entry) => (entry as { kind: string }).kind === 'quarantine')
      .map((entry) => {
        const { bundleId, reason } = entry as {
          bundleId: string;
          reason: { code: string };
        };

        return { bundleId, code: reason.code };
      }),
    [
      { bundleId: 'probe-provider', code: 'activate_failed' },
      { bundleId: 'probe-dependent', code: 'dependency_quarantined' },
    ],
  );
  assert.deepEqual(desktop.failures, []);
  assert.equal(desktop.steps.at(-1), 'ready');
});
