import {
  type CallScope,
  DoricGenerationV1,
  HooksV1,
  type Log,
  LogV1,
  ModelsV1,
  SecretsV1,
  type Services,
  StorageV1,
} from 'bundle/contracts';
import type { SandboxLease } from 'sandpool';

import {
  ConfigurationV1,
  type ConfigurationValue,
  type DoricConfiguration,
} from '../contracts/configuration.js';
import { type Executor, ExecutorV1 } from '../contracts/executor.js';
import { RuntimeHooksV1 } from '../contracts/hooks.js';
import type { RuntimeOwner } from '../contracts/runtime.js';
import { SandboxV1 } from '../contracts/sandbox.js';
import type { CredentialPort } from './domain/git-credentials.js';
import { checkStorageHealth } from './domain/storage-pressure.js';
import type { ModelCatalogSource } from './domain/usage-context.js';

/*
 * The internal ports the runtime domain uses in place of agents/doric's
 * service options (design 57 §4.3). Each one is a thin read of a required
 * contract; the domain never sees `services`.
 */

export interface RuntimePorts {
  /** host-config/v1.current(): the configuration in force right now. */
  configuration(): Promise<DoricConfiguration>;
  /** The secrets/v1 resolution rules of agents/doric credentials/resolve.ts. */
  readonly credentials: CredentialPort;
  /** The redaction list of the secrets store, in its cache order. */
  storedRedactions(): Promise<readonly string[]>;
  /** The credential ids the configured providers name in `secret` fields. */
  claimedCredentials(
    configuration: ConfigurationValue,
  ): Promise<ReadonlySet<string>>;
  readonly sandbox: {
    acquire(input: {
      readonly identity: string;
      readonly signal: AbortSignal;
    }): Promise<SandboxLease>;
    discard(identity: string): Promise<void>;
  };
  /** executor/v1, bound to the prompt it runs. */
  executor(scope: Required<Omit<CallScope, 'windowKey'>>): Executor;
  /** storage/v1.health() under the 10 % rule; rejects with StoragePressureError. */
  checkStorage(): Promise<void>;
  /** The configured provider models/v1 resolves, for its catalog capacity. */
  catalogSource(providerId: string, model: string): Promise<ModelCatalogSource>;
  readonly log: Log;
  /** runtime.hooks/v1, fired without waiting. */
  readonly hooks: {
    projectReady(projectId: string): void;
    projectClosing(projectId: string): void;
    /**
     * onThreadsClosingHook (1.1.0), awaited by the runner; a failing handler
     * never fails the close.
     */
    threadsClosing?(input: {
      readonly projectId: string;
      readonly threadIds: readonly string[];
    }): Promise<void>;
  };
  /**
   * This runtime process, the owner it records on the Projects it holds
   * (57-WP-H); undefined in a host without generations, which records none.
   */
  generation?(): Promise<RuntimeOwner | undefined>;
}

export const createPorts = (services: Services): RuntimePorts => {
  const configuration = services.use(ConfigurationV1);
  const secrets = services.use(SecretsV1);
  const sandbox = services.use(SandboxV1);
  const storage = services.use(StorageV1);
  const models = services.use(ModelsV1);
  const log = services.use(LogV1);
  const hooks = services.use(HooksV1).define(RuntimeHooksV1);
  const generation = services.use(DoricGenerationV1);
  const observe = (fired: Promise<unknown>) => {
    // An observe hook never fails the commit that fired it.
    fired.catch(() => undefined);
  };

  return {
    configuration: () => configuration.current(),
    credentials: {
      byId: (id) => secrets.resolve({ id }),
      byKind: (kind) => secrets.resolveByKind(kind),
      byUnclaimedKind: (kind, claimed) =>
        secrets.resolveByKind(kind, { exclude: [...claimed] }),
    },
    storedRedactions: () => secrets.redactions(),
    claimedCredentials: async ({ providers }) => {
      const ids = new Set<string>();
      for (const provider of providers) {
        const kind = await models.kind(provider.kind);
        for (const field of kind?.fields ?? []) {
          if (field.kind !== 'secret') continue;
          const id = provider.configuration[field.key];
          if (id !== undefined) ids.add(id);
        }
      }
      return ids;
    },
    sandbox: {
      acquire: (input) => sandbox.acquire(input),
      discard: (identity) => sandbox.discard(identity),
    },
    executor: (scope) => services.use(ExecutorV1, scope),
    checkStorage: () => checkStorageHealth(storage),
    catalogSource: async (providerId, model) =>
      (await models.resolve({ providerId, model }))
        .languageModel as unknown as ModelCatalogSource,
    log,
    // A single-process host has no doric.generation/v1: no owner is recorded.
    generation: async () => {
      try {
        const { generation: number, incarnation } = await generation.describe();
        return { generation: number, incarnation };
      } catch {
        return undefined;
      }
    },
    hooks: {
      projectReady: (projectId) => {
        observe(hooks.onProjectReadyHook.execute({ projectId }));
      },
      projectClosing: (projectId) => {
        observe(hooks.onProjectClosingHook.execute({ projectId }));
      },
      threadsClosing: async ({ projectId, threadIds }) => {
        await hooks.onThreadsClosingHook
          .execute({ projectId, threadIds: [...threadIds] })
          .catch(() => undefined);
      },
    },
  };
};
