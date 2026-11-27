// T2.2 (bundle-isolation, step 2(b), AC2.3): the core's desktop-facing
// contracts take no scope keys from a window. Driven through the single IPC
// dispatcher over the real core bundle's built manifest, descriptor and
// schemas. The generation process is a fake (a provider record per desktopMain
// contract). The host contracts (tools/v1, models/v1, secrets/v1) have no
// envelope route: windows reach them only over the `doric:connect` relay, so
// their envelope call is refused as unreachable before any scope check. The
// relay's own scope check for host contracts is RK37 and still pending; this
// suite moves onto the relay with it.

import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';

import type { JsonObject } from 'bundle/contracts';
import {
  type DistributionCatalog,
  type ProviderRecord,
  ServiceDirectory,
} from 'bundle/runtime';

import { generationView } from '../src/platform/bridge/client-routing';
import {
  type DesktopEvent,
  Dispatcher,
} from '../src/platform/bridge/dispatcher';
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

/**
 * The core contracts that accept no scope key from a window, in spec order.
 * The first three are served by the host (`DESKTOP`-exposed methods of host
 * contracts); the last three are the generation process's desktopMain ones.
 */
const SCOPE_FREE = [
  'windows/v1',
  'menus/v1',
  'tools/v1',
  'models/v1',
  'secrets/v1',
  'core.commands/v1',
] as const;

type ScopeFree = (typeof SCOPE_FREE)[number];

/** Each window scope key with a plausible value, as the dispatcher reads scope. */
const SCOPE_KEYS = [
  ['projectId', 'p1'],
  ['threadId', 't1'],
  ['promptId', 'pr1'],
] as const;

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

/** The contracts the host serves, rather than the generation process. */
const HOST_CONTRACTS = new Set<ScopeFree>([
  'tools/v1',
  'models/v1',
  'secrets/v1',
]);

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
    // This suite never reads the connection: the fake never changes.
    connection: {
      status: () => 'disconnected' as const,
      subscribe: () => () => undefined,
    },
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

/** The refusal of a window's envelope call to a host contract. */
const unreachable = (contract: ScopeFree) => ({
  ok: false,
  error: {
    code: 'unavailable',
    message: `No provider of ${contract} ${CALLS[contract].method} is reachable from this window.`,
    details: { contract, method: CALLS[contract].method },
  },
});

describe('core contracts take no scope keys from a window (T2.2)', () => {
  for (const contract of SCOPE_FREE) {
    if (HOST_CONTRACTS.has(contract)) {
      // A host contract has no envelope route: the call is refused as
      // unreachable, never reaching the scope check or the host. The scope
      // check on the `doric:connect` relay is RK37 (pending).
      for (const [key, value] of SCOPE_KEYS) {
        test(`refuses a window envelope call to ${contract} carrying ${key} as unavailable, before the scope check`, async () => {
          const result = await windowCall(contract, { [key]: value });

          assert.deepEqual(result, unreachable(contract));
        });
      }

      test(`refuses a window envelope call to ${contract} with no scope as unavailable`, async () => {
        const result = await windowCall(contract);

        assert.deepEqual(result, unreachable(contract));
      });

      continue;
    }

    for (const [key, value] of SCOPE_KEYS) {
      test(`refuses a window call to ${contract} carrying ${key} with invalid_input`, async () => {
        const result = await windowCall(contract, { [key]: value });

        assert.equal(
          (result as { error?: { code: string } }).error?.code,
          'invalid_input',
          JSON.stringify(result),
        );
      });
    }

    test(`serves a window call to ${contract} with no scope`, async () => {
      const result = await windowCall(contract);

      assert.deepEqual(result, { ok: true, output: CALLS[contract].output });
    });
  }
});
