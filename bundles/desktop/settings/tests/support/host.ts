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
  defineMethod,
  defineService,
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
import type {
  ConfigReplaceResult,
  DoricConfiguration,
} from 'runtime/contracts';
import type { z } from 'zod';

import {
  createSettingsApi,
  HostConfigurationV1,
  type SettingsApi,
} from '../../src/client/api/settings-api.js';

export interface FakeHost {
  claudeLogin?: () => CredentialDescription;
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
  tools?: () => readonly ToolCatalogEntry[];
  list?: () => readonly CredentialDescription[];
  create?: (input: CredentialCreate) => CredentialDescription;
  update?: (
    ref: CredentialRef,
    input: CredentialUpdate,
  ) => CredentialDescription;
  delete?: (ref: CredentialRef) => 'deleted' | 'missing' | 'referenced';
}

const unanswered = (): never => {
  throw new Error('The fake host was not given this answer.');
};

type Specs = Readonly<
  Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>
>;

/** A provider of every method of a contract; the unlisted ones answer nothing. */
const fake = (
  id: string,
  specs: Specs,
  handlers: Readonly<Record<string, (input: never) => unknown>>,
): AnyServiceDefinition =>
  defineService(
    id as `${string}/v${number}`,
    Object.fromEntries(
      Object.entries(specs).map(([name, spec]) => [
        name,
        defineMethod({
          input: spec.input,
          output: spec.output,
          execute: async (input: unknown) =>
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
      login: () => (host.claudeLogin ?? unanswered)(),
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
  ];
  const test = createTestServices({ bundle: { id: 'settings' }, provide });

  try {
    await run(createSettingsApi(test.services));
  } finally {
    await test.dispose();
  }
};

/** Whether a rejection shows exactly `message`, the text a surface renders. */
export const showing =
  (message: string) =>
  (error: unknown): boolean =>
    error instanceof Error && error.message === message;
