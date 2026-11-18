// T2.2 (bundle-isolation, step 2(b), AC2.3): the core's desktop-facing
// contracts take no scope keys from a window. Driven through the single IPC
// dispatcher over the real core bundle's built manifest, descriptor and
// schemas. The two remote ends are the real boundaries and are faked: the
// generation process (a provider record per desktopMain contract) and the
// host (an in-memory socket that answers every call).

import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';

import type { JsonObject } from 'bundle/contracts';
import {
  type CallMessage,
  type DistributionCatalog,
  type ProviderRecord,
  ServiceDirectory,
} from 'bundle/runtime';

import { ConnectionRelay } from '../src/connection/relay';
import { generationView } from '../src/platform/bridge/client-routing';
import {
  type DesktopEvent,
  Dispatcher,
} from '../src/platform/bridge/dispatcher';
import {
  type BridgeSocket,
  createHostBridge,
} from '../src/platform/bridge/host-bridge';
import { createSchemaValidators } from '../src/platform/bridge/validation';
import { resolveDistribution } from '../src/platform/catalog/resolve';
import type { GenerationProcess } from '../src/platform/generation/process';
import { silentLog } from '../src/platform/log';
import { SplashStates } from '../src/platform/splash/state';
import {
  type WindowEntry,
  WindowRegistry,
} from '../src/platform/windows/registry';
import { coreDistribution } from './support/core';

/** The core contracts whose window scope keys step 2(b) removes, in spec order. */
const SCOPED_IN_PHASE_0 = [
  'windows/v1',
  'menus/v1',
  'tools/v1',
  'models/v1',
  'secrets/v1',
  'core.commands/v1',
] as const;

type ScopeFree = (typeof SCOPED_IN_PHASE_0)[number];

/** The core contracts that accept no scope key from a window, in spec order. */
const SCOPE_FREE: readonly ScopeFree[] = [
  'windows/v1',
  'menus/v1',
  'tools/v1',
  'models/v1',
  'secrets/v1',
];

/**
 * One desktop-exposed method per contract, with an input its real schema
 * accepts, and what the faked provider answers (valid for its output schema).
 */
const CALLS: Record<
  ScopeFree,
  { readonly method: string; readonly input: unknown; readonly output: unknown }
> = {
  'windows/v1': {
    method: 'open',
    input: { key: 'probe', path: '/' },
    output: null,
  },
  'menus/v1': {
    method: 'setContext',
    input: { key: 'path', value: null },
    output: null,
  },
  'tools/v1': { method: 'catalog', input: [], output: [] },
  'models/v1': { method: 'kinds', input: [], output: [] },
  'secrets/v1': { method: 'list', input: [], output: [] },
  'core.commands/v1': {
    method: 'execute',
    input: { id: 'probe.command/v1', input: null },
    output: null,
  },
};

let catalog: DistributionCatalog;
let artifacts: ReadonlyMap<string, Buffer>;

before(async () => {
  ({ catalog, artifacts } = await coreDistribution());
});

/** The host side of the bridge: connected, answering each call by contract. */
const answeringHost = (): BridgeSocket => {
  const listeners = new Map<string, (message: unknown) => void>();

  return {
    connected: true,
    on: (name, listener) => {
      listeners.set(name, listener as (message: unknown) => void);
    },
    emit: (name, message) => {
      if (name !== 'call') {
        return;
      }

      const call = message as CallMessage;
      const answer = CALLS[call.contract as ScopeFree];

      queueMicrotask(() =>
        listeners.get('result')?.({
          kind: 'result',
          id: call.id,
          ok: true,
          output: answer?.output,
        }),
      );
    },
    connect: () => undefined,
    disconnect: () => undefined,
  };
};

/** The core's desktopMain providers as the generation process lists them. */
const desktopMainRecords = (): ServiceDirectory => {
  const records = new ServiceDirectory();

  for (const contractId of [
    'windows/v1',
    'menus/v1',
    'core.commands/v1',
  ] as const) {
    const record: ProviderRecord = {
      contractId,
      bundleId: 'core',
      version: catalog.bundles.find((bundle) => bundle.id === 'core')
        ?.version as string,
      contractVersion: '1.0.0',
      environment: 'desktopMain',
      cardinality: 'one',
      methods: {},
      origin: 'remote',
      invoke: () => CALLS[contractId].output,
    };

    records.register(record);
  }

  return records;
};

const contents = {
  id: 11,
  mainFrame: undefined,
  getURL: () => 'doric://app/projects/p1/threads/t1',
  reload: () => undefined,
  once: () => undefined,
  isDestroyed: () => false,
  send: () => undefined,
};

const event = { sender: contents, senderFrame: { url: contents.getURL() } };

let dispatcher: Dispatcher;

beforeEach(() => {
  const registry = new WindowRegistry();
  const files = new Map(
    catalog.bundles.map((bundle) => [bundle.id, bundle] as const),
  );
  const resolution = resolveDistribution(catalog, 1);
  const view = generationView({
    generation: 1,
    mode: 'connected',
    catalog,
    resolution,
    read: (bundle, path) => {
      const file = files
        .get(bundle.id)
        ?.files.find((candidate) => candidate.path === path);
      const content =
        file === undefined ? undefined : artifacts.get(file.sha256);

      return content === undefined
        ? undefined
        : (JSON.parse(content.toString()) as JsonObject);
    },
  });
  const records = desktopMainRecords();
  const workspace: WindowEntry = {
    key: 'workspace',
    kind: 'path',
    window: { webContents: contents } as unknown as WindowEntry['window'],
    contents: contents as unknown as WindowEntry['contents'],
    appearance: { titleBar: 'integrated', background: 'window' },
    primary: true,
    pinnedGeneration: 1,
    context: { path: null, focus: null },
  };

  registry.add(workspace);

  dispatcher = new Dispatcher({
    registry,
    validators: createSchemaValidators(),
    host: createHostBridge(answeringHost()),
    log: silentLog,
    splashContents: () => undefined,
    splashStates: new SplashStates(),
    splashAct: async () => undefined,
    view: (generation) => (generation === 1 ? view : undefined),
    process: (generation) =>
      generation === 1
        ? ({ records, alive: true } as unknown as GenerationProcess)
        : undefined,
    pinWindow: () => true,
    chrome: () => ({
      titleBar: 'integrated',
      height: 36,
      safeArea: { top: 0, left: 80, right: 0 },
    }),
    tokens: () => ({}),
    appVersion: '0.0.1',
    answerClose: () => undefined,
    windowReady: () => undefined,
    windowFailure: () => undefined,
    bindingsFor: () => [],
    dispatchCommand: async () => undefined,
    diagnostic: () => undefined,
    connection: new ConnectionRelay(),
    openExternal: async () => undefined,
    appearanceGet: () => 'dark',
    appearanceSet: async () => undefined,
  });
});

/** A window call from the core's client part to one scope-free contract. */
const windowCall = (contract: ScopeFree, scope?: Record<string, string>) =>
  dispatcher.handle(event as DesktopEvent, {
    op: 'call',
    envelope: {
      id: `w-${contract}`,
      contract,
      method: CALLS[contract].method,
      input: CALLS[contract].input,
      bundleId: 'core',
      deadline: 0,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      ...(scope === undefined ? {} : { scope }),
    },
  });

describe('core contracts take no scope keys from a window (T2.2)', () => {
  for (const contract of SCOPE_FREE) {
    test(`refuses a window call to ${contract} carrying projectId with invalid_input`, async () => {
      const result = await windowCall(contract, { projectId: 'p1' });

      assert.equal(
        (result as { error?: { code: string } }).error?.code,
        'invalid_input',
        JSON.stringify(result),
      );
    });

    test(`serves a window call to ${contract} with no scope`, async () => {
      const result = await windowCall(contract);

      assert.deepEqual(result, { ok: true, output: CALLS[contract].output });
    });
  }
});
