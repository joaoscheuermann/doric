import {
  type AnyMethodDefinition,
  ContractError,
  type CredentialKind,
  defineMethod,
  defineService,
  type Secret,
  SecretsV1,
  type ServiceDefinition,
  secretsMethods,
} from 'bundle/contracts';
import type { z } from 'zod';

/*
 * A fake `secrets/v1` over a live credential list, answering the resolution
 * rules and errors the core's facade answers (agents/doric's
 * `credentialResolver` helper, moved for design 57 §4.3): a missing id is
 * `credential_missing`, several matches of a kind are `credential_ambiguous`,
 * none is undefined, and the redaction list is every non-empty stored secret
 * in list order.
 */

export type { Secret } from 'bundle/contracts';

const missing = (id: string) =>
  new ContractError('credential_missing', `Credential ${id} is not stored.`, {
    id,
  });

const ambiguous = (kind: CredentialKind) =>
  new ContractError(
    'credential_ambiguous',
    `More than one ${kind} credential is stored; name the one to use.`,
    { kind },
  );

/**
 * Every member of a basic contract's spec: the given ones, and the rest
 * refusing, since a basic provider must implement exactly its contract.
 */
export const complete = (
  spec: Readonly<
    Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>
  >,
  given: Readonly<Record<string, AnyMethodDefinition>>,
): Record<string, AnyMethodDefinition> =>
  Object.fromEntries(
    Object.entries(spec).map(([name, method]) => [
      name,
      given[name] ??
        defineMethod({
          ...method,
          execute: () => {
            throw new Error(`${name} is not used by the runtime tests.`);
          },
        }),
    ]),
  );

export const secretsProvider = (
  list: () => readonly Secret[] = () => [],
): ServiceDefinition =>
  defineService(
    SecretsV1.id,
    complete(secretsMethods, {
      resolve: defineMethod({
        ...secretsMethods.resolve,
        execute: async ({ id }) => {
          const found = list().find((credential) => credential.id === id);
          if (found === undefined) throw missing(id);
          return found;
        },
      }),
      resolveByKind: defineMethod({
        ...secretsMethods.resolveByKind,
        execute: async ([kind, options]) => {
          const excluded = new Set(options?.exclude ?? []);
          const matches = list().filter(
            (credential) =>
              credential.kind === kind && !excluded.has(credential.id),
          );
          if (matches.length > 1) throw ambiguous(kind);
          return matches[0];
        },
      }),
      redactions: defineMethod({
        ...secretsMethods.redactions,
        execute: async () =>
          list().flatMap(({ secret }) =>
            secret === undefined || secret === '' ? [] : [secret],
          ),
      }),
    }),
  );
