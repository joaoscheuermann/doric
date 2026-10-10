// The single IPC dispatcher (section 14.3), driven with the payloads the
// preload sends and fake ipc events: the window's webContents is the real
// boundary; the generation process and the host are the two remote ends.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import type { Call, NotificationRequest } from 'bundle/contracts';
import { type ProviderRecord, ServiceDirectory } from 'bundle/runtime';

import { ConnectionRelay } from '../src/connection/relay';
import type { ConnectionListener } from '../src/connection/status';
import {
  type GenerationView,
  generationView,
} from '../src/platform/bridge/client-routing';
import {
  type DesktopEvent,
  Dispatcher,
} from '../src/platform/bridge/dispatcher';
import { createHostBridge } from '../src/platform/bridge/host-bridge';
import { createSchemaValidators } from '../src/platform/bridge/validation';
import { resolveDistribution } from '../src/platform/catalog/resolve';
import type { GenerationProcess } from '../src/platform/generation/process';
import { silentLog } from '../src/platform/log';
import { SplashStates } from '../src/platform/splash/state';
import {
  type WindowEntry,
  WindowRegistry,
} from '../src/platform/windows/registry';
import { fixtureDistribution } from './support/distribution';

const pingDocument = {
  $defs: {
    'ping.input': {
      type: 'array',
      prefixItems: [{ type: 'string' }],
      minItems: 1,
      maxItems: 1,
    },
    'ping.output': { type: 'string' },
    'slow.input': { type: 'array', maxItems: 0 },
    'slow.output': {},
    'register.input': { 'x-doric-local': true },
    'register.output': { 'x-doric-local': 'disposable' },
  },
};

const { catalog } = fixtureDistribution({
  core: 'mincore',
  bundles: [
    { id: 'mincore', files: { 'desktop/index.js': '' } },
    {
      id: 'probe',
      provides: [
        {
          id: 'probe.api/v1',
          environment: 'desktopMain',
          document: pingDocument,
        },
      ],
      requires: ['remote.api/v1@^1.0.0'],
      files: { 'desktop/index.js': '', 'client/index.js': '' },
    },
    {
      id: 'remote',
      provides: [
        { id: 'remote.api/v1', environment: 'host', document: pingDocument },
        { id: 'other.api/v1', environment: 'host', document: pingDocument },
      ],
    },
  ],
});
const files = new Map(
  catalog.bundles.map((bundle) => [bundle.id, bundle] as const),
);

interface Sent {
  readonly channel: string;
  readonly payload: unknown;
}

const fakeContents = (id: number, url: string) => {
  const sent: Sent[] = [];
  let reloads = 0;
  const contents = {
    id,
    mainFrame: undefined,
    getURL: () => url,
    reload: () => {
      reloads += 1;
    },
    once: () => undefined,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) =>
      sent.push({ channel, payload }),
  };

  return { contents, sent, reloads: () => reloads };
};

const event = (
  contents: ReturnType<typeof fakeContents>['contents'],
  url = contents.getURL(),
): DesktopEvent => ({ sender: contents, senderFrame: { url } }) as DesktopEvent;

let registry: WindowRegistry;
let view: GenerationView;
let calls: { method: string; input: unknown; call: Call }[];
let records: ServiceDirectory;
let dispatcher: Dispatcher;
let workspace: WindowEntry;
let window: ReturnType<typeof fakeContents>;
let hostConnected: boolean;
let relay: ConnectionRelay;
let notified: NotificationRequest[];

/** The `/status` monitor's surface: a status and its change listeners. */
const statusSource = (initial: 'connected' | 'disconnected') => {
  let current = initial;
  const listeners = new Set<ConnectionListener>();

  return {
    status: () => current,
    subscribe: (listener: ConnectionListener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    set: (status: 'connected' | 'disconnected') => {
      current = status;

      for (const listener of listeners) {
        listener(status);
      }
    },
  };
};

const envelope = (overrides: Record<string, unknown> = {}) => ({
  id: 'w-1',
  contract: 'probe.api/v1',
  method: 'ping',
  input: ['hello'],
  bundleId: 'probe',
  deadline: 0,
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  ...overrides,
});

beforeEach(() => {
  registry = new WindowRegistry();
  calls = [];
  records = new ServiceDirectory();
  hostConnected = false;
  relay = new ConnectionRelay();
  notified = [];

  const resolution = resolveDistribution(catalog, 1);

  view = generationView({
    generation: 1,
    mode: 'connected',
    catalog,
    resolution,
    read: (bundle, path) => {
      const source = files.get(bundle.id);
      const file = source?.files.find((candidate) => candidate.path === path);

      return file === undefined ? undefined : pingDocument;
    },
  });

  const record: ProviderRecord = {
    contractId: 'probe.api/v1',
    bundleId: 'probe',
    version: '1.0.0',
    contractVersion: '1.0.0',
    environment: 'desktopMain',
    cardinality: 'one',
    methods: {},
    origin: 'remote',
    invoke: (method, input, call) => {
      calls.push({ method, input, call });

      if (method === 'slow') {
        return new Promise((resolve) => {
          call.signal.addEventListener('abort', () => resolve('aborted'));
        });
      }

      return `pong:${(input as string[])[0]}`;
    },
  };

  records.register(record);

  window = fakeContents(11, 'doric://app/projects/p1/threads/t1');
  workspace = {
    key: 'workspace',
    window: {
      webContents: window.contents,
    } as unknown as WindowEntry['window'],
    appearance: { titleBar: 'integrated', background: 'window' },
    pinnedGeneration: null,
    context: { path: null, focus: null },
  };
  registry.add(workspace);

  const host = createHostBridge({
    get connected() {
      return hostConnected;
    },
    on: () => undefined,
    emit: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
  });

  dispatcher = new Dispatcher({
    registry,
    validators: createSchemaValidators(),
    host,
    log: silentLog,
    splashContents: () => undefined,
    splashStates: new SplashStates(),
    splashAct: async () => undefined,
    view: (generation) => (generation === 1 ? view : undefined),
    process: (generation) =>
      generation === 1
        ? ({ records, alive: true } as unknown as GenerationProcess)
        : undefined,
    pinWindow: (entry, generation) => {
      if (generation !== 1) {
        return false;
      }

      entry.pinnedGeneration = generation;

      return true;
    },
    chrome: () => ({
      titleBar: 'integrated',
      height: 36,
      safeArea: { top: 0, left: 80, right: 0 },
    }),
    tokens: () => ({}),
    answerClose: () => undefined,
    windowReady: () => undefined,
    windowFailure: () => undefined,
    bindingsFor: () => [{ key: 'CmdOrCtrl+K', command: 'probe.ping/v1' }],
    dispatchCommand: async () => undefined,
    diagnostic: () => undefined,
    connection: relay,
    notify: (request) => {
      notified.push(request);
    },
  });
});

const describeWindow = () =>
  dispatcher.handle(event(window.contents), {
    op: 'describeWindow',
    generation: 1,
  });

describe('desktop IPC dispatcher', () => {
  test('refuses senders that are not a known doric://app window with today’s text', async () => {
    const stranger = fakeContents(99, 'doric://app/');

    for (const [sender, url] of [
      [window.contents, 'file:///Doric/doric-renderer/index.html'],
      [window.contents, 'http://localhost:4200/'],
      [stranger.contents, 'doric://app/'],
    ] as const) {
      await assert.rejects(
        dispatcher.handle(event(sender, url), { op: 'describeWindow' }),
        { message: 'The request source is not allowed.' },
      );
    }
  });

  test('pins the window to the generation of its shell and describes it', async () => {
    assert.deepEqual(await describeWindow(), {
      key: 'workspace',
      kind: 'window',
      path: '/projects/p1/threads/t1',
      generation: 1,
      chrome: {
        titleBar: 'integrated',
        height: 36,
        safeArea: { top: 0, left: 80, right: 0 },
      },
      mode: 'connected',
      tokens: {},
    });
    assert.equal(workspace.pinnedGeneration, 1);
  });

  test('a shell of a generation main no longer retains is reloaded', async () => {
    await assert.rejects(
      dispatcher.handle(event(window.contents), {
        op: 'catalog',
        generation: 7,
      }),
      { code: 'unavailable' },
    );
    assert.equal(window.reloads(), 1);
  });

  test('a client call gets its caller from the bundle and the pinned generation, and the window key from main', async () => {
    await describeWindow();

    const result = await dispatcher.handle(event(window.contents), {
      op: 'call',
      envelope: envelope({ scope: { projectId: 'p1' } }),
    });

    assert.deepEqual(result, { ok: true, output: 'pong:hello' });
    assert.deepEqual(calls[0]?.call.caller, {
      bundleId: 'probe',
      version: '1.0.0',
      generation: 1,
    });
    assert.deepEqual(calls[0]?.call.scope, {
      projectId: 'p1',
      windowKey: 'workspace',
    });
    assert.equal(
      calls[0]?.call.trace.traceparent,
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
  });

  test('refuses what the calling part did not declare, with undeclared_requirement', async () => {
    await describeWindow();

    for (const contract of ['other.api/v1', 'doric.windows/v1']) {
      const result = await dispatcher.handle(event(window.contents), {
        op: 'call',
        envelope: envelope({ contract }),
      });

      assert.equal(
        (result as { error?: { code: string } }).error?.code,
        'undeclared_requirement',
        contract,
      );
    }
  });

  test('a process-local method answers local_only and an invalid input invalid_input', async () => {
    await describeWindow();

    const local = await dispatcher.handle(event(window.contents), {
      op: 'call',
      envelope: envelope({ method: 'register', input: [] }),
    });
    const invalid = await dispatcher.handle(event(window.contents), {
      op: 'call',
      envelope: envelope({ input: [42] }),
    });

    assert.equal(
      (local as { error?: { code: string } }).error?.code,
      'local_only',
    );
    assert.equal(
      (invalid as { error?: { code: string } }).error?.code,
      'invalid_input',
    );
    assert.equal(calls.length, 0);
  });

  test('a cancel reaches the running call', async () => {
    await describeWindow();

    const pending = dispatcher.handle(event(window.contents), {
      op: 'call',
      envelope: envelope({ id: 'w-slow', method: 'slow', input: [] }),
    });

    await new Promise((resolve) => setImmediate(resolve));
    await dispatcher.handle(event(window.contents), {
      op: 'cancel',
      id: 'w-slow',
    });

    assert.deepEqual(await pending, { ok: true, output: 'aborted' });
  });

  test('a host call while the bridge is down answers today’s unavailable message', async () => {
    await describeWindow();

    const result = await dispatcher.handle(event(window.contents), {
      op: 'call',
      envelope: envelope({ contract: 'remote.api/v1' }),
    });

    assert.deepEqual(result, {
      ok: false,
      error: { code: 'unavailable', message: 'Doric backend is unavailable.' },
    });
  });

  test('the window platform may call only doric.shell/v1; its keybindings stream starts with the table', async () => {
    await describeWindow();

    const refused = await dispatcher.handle(event(window.contents), {
      op: 'call',
      envelope: envelope({ bundleId: null }),
    });
    const subscribed = await dispatcher.handle(event(window.contents), {
      op: 'subscribe',
      envelope: envelope({
        id: 'w-keys',
        bundleId: null,
        contract: 'doric.shell/v1',
        method: 'keybindings',
        input: [],
      }),
    });

    assert.equal(
      (refused as { error?: { code: string } }).error?.code,
      'undeclared_requirement',
    );
    assert.deepEqual(subscribed, { ok: true, output: undefined });
    assert.deepEqual(window.sent.at(-1), {
      channel: 'doric:desktop:push',
      payload: {
        type: 'event',
        id: 'w-keys',
        event: [{ key: 'CmdOrCtrl+K', command: 'probe.ping/v1' }],
      },
    });
  });

  test('every window follows the host connection: the current status first, then each change, until it navigates', async () => {
    const source = statusSource('connected');
    const subscribe = (contents: ReturnType<typeof fakeContents>, id: string) =>
      dispatcher.handle(event(contents.contents), {
        op: 'subscribe',
        envelope: envelope({
          id,
          bundleId: null,
          contract: 'doric.shell/v1',
          method: 'connection',
          input: [],
        }),
      });
    const settings = fakeContents(12, 'doric://app/settings/providers');

    registry.add({
      key: 'settings',
      window: {
        webContents: settings.contents,
      } as unknown as WindowEntry['window'],
      appearance: { titleBar: 'integrated', background: 'window' },
      pinnedGeneration: null,
      context: { path: null, focus: null },
    });
    await describeWindow();
    await dispatcher.handle(event(settings.contents), {
      op: 'describeWindow',
      generation: 1,
    });

    assert.deepEqual(await subscribe(window, 'w-conn'), {
      ok: true,
      output: undefined,
    });
    await subscribe(settings, 's-conn');
    relay.attach(source);
    source.set('disconnected');
    source.set('disconnected');
    dispatcher.navigating(settings.contents.id);
    source.set('connected');

    const statuses = (sent: Sent[], id: string) =>
      sent
        .map(({ payload }) => payload as { id?: string; event?: unknown })
        .filter((payload) => payload.id === id)
        .map((payload) => payload.event);

    assert.deepEqual(statuses(window.sent, 'w-conn'), [
      'disconnected',
      'connected',
      'disconnected',
      'connected',
    ]);
    assert.deepEqual(statuses(settings.sent, 's-conn'), [
      'disconnected',
      'connected',
      'disconnected',
    ]);
  });

  test('a window notification reaches main with exactly a title and a body', async () => {
    await describeWindow();

    const shown = await dispatcher.handle(event(window.contents), {
      op: 'call',
      envelope: envelope({
        bundleId: null,
        contract: 'doric.shell/v1',
        method: 'notify',
        input: { title: 'Thread finished', body: 'Done.' },
      }),
    });
    const refused = await dispatcher.handle(event(window.contents), {
      op: 'call',
      envelope: envelope({
        id: 'w-2',
        bundleId: null,
        contract: 'doric.shell/v1',
        method: 'notify',
        input: { title: 'Thread finished' },
      }),
    });

    assert.deepEqual(shown, { ok: true, output: undefined });
    assert.equal(
      (refused as { error?: { code: string } }).error?.code,
      'invalid_input',
    );
    assert.deepEqual(notified, [{ title: 'Thread finished', body: 'Done.' }]);
  });
});
