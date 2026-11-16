// The host contracts the settings adapter reaches over the bridge, as fake
// providers with the contracts' own method schemas: the boundary of these
// tests is the contract, so each fake answers what the host's provider would
// and records what it was asked.

import {
  type AnyServiceDefinition,
  type CatalogResult,
  type CredentialCreate,
  type CredentialDescription,
  type CredentialRef,
  type CredentialUpdate,
  type Disposable,
  defineMethod,
  defineService,
  type ModelIconAnswers,
  type ModelIconRequest,
  type ModelKindDescriptor,
  ModelsV1,
  modelsMethods,
  SecretsV1,
  secretsMethods,
  type ToolCatalogEntry,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import { ClaudeLoginV1, claudeLoginMethods } from 'claude-login/contracts';
import { configurationMethods } from 'host-config/contracts';
import { LayoutWorkspaceV1, layoutWorkspaceMethods } from 'layout/contracts';
import {
  type ConfigReplaceResult,
  type DoricConfiguration,
  runtimeThreadsMethods,
  type Thread,
  type ThreadExecutionResult,
} from 'runtime/contracts';
import type { z } from 'zod';

import {
  createSettingsApi,
  HostConfigurationV1,
  type SettingsApi,
} from '../../src/client/api/settings-api.js';

export interface FakeHost {
  claudeStart?: () => { readonly url: string };
  claudeFinish?: () => CredentialDescription;
  current?: () => DoricConfiguration | Promise<DoricConfiguration>;
  replace?: (
    input: unknown,
  ) => ConfigReplaceResult | Promise<ConfigReplaceResult>;
  kinds?: () => readonly ModelKindDescriptor[];
  kind?: (id: string) => ModelKindDescriptor | undefined;
  catalog?: (input: {
    kind: string;
    configuration: Readonly<Record<string, string>>;
  }) => CatalogResult;
  icons?: (input: {
    readonly requests: readonly ModelIconRequest[];
  }) => ModelIconAnswers;
  tools?: () => readonly ToolCatalogEntry[];
  list?: () => readonly CredentialDescription[];
  create?: (input: CredentialCreate) => CredentialDescription;
  update?: (
    ref: CredentialRef,
    input: CredentialUpdate,
  ) => CredentialDescription;
  delete?: (ref: CredentialRef) => 'deleted' | 'missing' | 'referenced';
  /** `layout.workspace/v1.selectedThread`: the workspace's selection. */
  selectedThread?: () => Thread | undefined;
  /** `layout.workspace/v1.subscribe`: the layout's change notifications. */
  workspaceSubscribe?: (listener: () => void) => Disposable;
  /** `runtime.threads/v1.setThreadExecution`. */
  setThreadExecution?: (input: {
    readonly id: string;
    readonly providerId: string;
    readonly model: string;
    readonly effort?: string;
  }) => ThreadExecutionResult | Promise<ThreadExecutionResult>;
}

const unanswered = (): never => {
  throw new Error('The fake host was not given this answer.');
};

type Specs = Readonly<
  Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>
>;

/**
 * A provider of every method of a contract; the unlisted ones answer nothing.
 * `answer` follows the contract: `async` methods answer a promise, `sync`
 * methods (such as `layout.workspace/v1`) answer their value directly.
 */
const fake = (
  id: string,
  specs: Specs,
  handlers: Readonly<Record<string, (input: never) => unknown>>,
  answer: 'async' | 'sync' = 'async',
): AnyServiceDefinition =>
  defineService(
    id as `${string}/v${number}`,
    Object.fromEntries(
      Object.entries(specs).map(([name, spec]) => [
        name,
        defineMethod({
          input: spec.input,
          output: spec.output,
          execute:
            answer === 'sync'
              ? (input: unknown) =>
                  (handlers[name] ?? unanswered)(input as never)
              : async (input: unknown) =>
                  (handlers[name] ?? unanswered)(input as never),
        }),
      ]),
    ),
  );

/** The settings adapter over fake host providers. */
export const settingsOver = async (
  host: FakeHost,
  run: (api: SettingsApi) => Promise<void>,
): Promise<void> => {
  const provide: AnyServiceDefinition[] = [
    fake(ClaudeLoginV1.id, claudeLoginMethods, {
      start: () => (host.claudeStart ?? unanswered)(),
      finish: () => (host.claudeFinish ?? unanswered)(),
    }),
    fake(HostConfigurationV1.id, configurationMethods, {
      current: () => (host.current ?? unanswered)(),
      replace: (input: unknown) => (host.replace ?? unanswered)(input),
    }),
    fake(ModelsV1.id, modelsMethods, {
      kinds: () => [...(host.kinds ?? unanswered)()],
      kind: ([id]: [string]) => (host.kind ?? unanswered)(id),
      catalog: (input: {
        kind: string;
        configuration: Record<string, string>;
      }) => (host.catalog ?? unanswered)(input),
      icons: (input: { requests: ModelIconRequest[] }) =>
        (host.icons ?? unanswered)(input),
    }),
    fake(ToolsV1.id, toolsMethods, {
      catalog: () => [...(host.tools ?? unanswered)()],
    }),
    fake(SecretsV1.id, secretsMethods, {
      list: () => [...(host.list ?? unanswered)()],
      create: (input: CredentialCreate) => (host.create ?? unanswered)(input),
      update: ([ref, input]: [CredentialRef, CredentialUpdate]) =>
        (host.update ?? unanswered)(ref, input),
      delete: (ref: CredentialRef) => (host.delete ?? unanswered)(ref),
    }),
    fake(
      LayoutWorkspaceV1.id,
      layoutWorkspaceMethods,
      {
        selectedThread: () => (host.selectedThread ?? unanswered)(),
        subscribe: (listener: () => void) =>
          (host.workspaceSubscribe ?? unanswered)(listener),
      },
      'sync',
    ),
    // Referenced by its id, as the settings adapter references it.
    fake('runtime.threads/v1', runtimeThreadsMethods as unknown as Specs, {
      setThreadExecution: (input: {
        id: string;
        providerId: string;
        model: string;
        effort?: string;
      }) => (host.setThreadExecution ?? unanswered)(input),
    }),
  ];
  const test = createTestServices({ bundle: { id: 'settings' }, provide });

  try {
    await run(createSettingsApi(test.services));
  } finally {
    await test.dispose();
  }
};

/**
 * The settings adapter's rejection (error-messages.md §6.4): a
 * `SettingsApiError` (name kept) carrying `code`, the unchanged `message`, and
 * `cause` — the contract error the host answered, or none (`undefined`).
 */
export const settingsError =
  (expected: {
    readonly code: string;
    readonly message: string;
    readonly cause: unknown;
  }) =>
  (error: unknown): boolean => {
    if (!(error instanceof Error)) {
      throw new Error(`Rejected with a non-error: ${String(error)}`);
    }
    const { code } = error as Error & { readonly code?: unknown };
    if (
      error.name !== 'SettingsApiError' ||
      code !== expected.code ||
      error.message !== expected.message ||
      error.cause !== expected.cause
    ) {
      throw new Error(
        `Expected SettingsApiError ${expected.code} "${expected.message}" ` +
          `(cause ${expected.cause === undefined ? 'none' : 'the contract error'}), ` +
          `got ${error.name} ${String(code)} "${error.message}" ` +
          `(cause ${error.cause === undefined ? 'none' : error.cause === expected.cause ? 'the contract error' : String(error.cause)})`,
      );
    }
    return true;
  };

/** Whether a rejection shows exactly `message`, the text a surface renders. */
export const showing =
  (message: string) =>
  (error: unknown): boolean =>
    error instanceof Error && error.message === message;
