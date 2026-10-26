// The world a `claude-login` test runs in: the host part activated beside a
// fake `secrets/v1` that records every call, with the bundle's OAuth seams
// injected as fakes. The boundary of these tests is the contract: the fake
// answers what the real host's provider would and records what it was asked.

import {
  type AnyServiceDefinition,
  ContractError,
  type CredentialCreate,
  type CredentialDescription,
  type CredentialRef,
  type CredentialUpdate,
  defineMethod,
  defineService,
  SecretsV1,
  secretsMethods,
} from 'bundle/contracts';
import { createTestServices, type TestServices } from 'bundle/testing';
import type { z } from 'zod';

import { type ClaudeLogin, ClaudeLoginV1 } from '../../src/contracts/index.js';
import { createActivate } from '../../src/host/index.js';
import {
  CLAUDE_CREDENTIAL_NAME,
  type ClaudeLoginDeps,
} from '../../src/host/login.js';

/** The refusal of an answer the world was not given. */
const unanswered = (): never => {
  throw new Error('The world was not given this answer.');
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

/** The description a stored create answers: the public view, never the secret. */
const descriptionOf = (
  id: string,
  input: CredentialCreate,
): CredentialDescription => ({
  id,
  kind: input.kind,
  name: input.name,
  ...(input.username === undefined ? {} : { username: input.username }),
  ...(input.email === undefined ? {} : { email: input.email }),
  hasSecret: input.secret !== undefined,
});

/** What the fake `secrets/v1` recorded, in call order. */
export interface SecretCalls {
  readonly created: readonly CredentialCreate[];
  readonly updated: readonly {
    readonly ref: CredentialRef;
    readonly input: CredentialUpdate;
  }[];
  readonly listed: number;
}

/** The world a `claude-login` test runs in. */
export interface LoginWorld {
  readonly world: TestServices;
  readonly secrets: SecretCalls;
  readonly providers: ClaudeLogin;
  /** Runs the bundle's deactivation cleanup, as the platform would. */
  readonly deactivate: () => Promise<void>;
}

/**
 * Activates the bundle beside a fake `secrets/v1` that records every call,
 * with the given OAuth seams injected. The fake store refuses a `create`
 * whose name and kind an existing credential holds, with the contract's own
 * `credential_name_taken`, so the name-taken path is a second sign-in away.
 */
export const loginWorld = async (
  deps: ClaudeLoginDeps = {},
): Promise<LoginWorld> => {
  const created: CredentialCreate[] = [];
  const updated: { ref: CredentialRef; input: CredentialUpdate }[] = [];
  let listed = 0;
  const stored: CredentialDescription[] = [];

  const secrets = fake(SecretsV1.id, secretsMethods, {
    list: () => {
      listed += 1;
      return [...stored];
    },
    create: (input: CredentialCreate) => {
      created.push(input);
      if (
        stored.some(
          (entry) => entry.kind === input.kind && entry.name === input.name,
        )
      ) {
        throw new ContractError(
          'credential_name_taken',
          `A credential named ${CLAUDE_CREDENTIAL_NAME} of kind ${input.kind} is already stored.`,
        );
      }
      const next = descriptionOf(
        `00000000-0000-4000-8000-900000000${String(stored.length + 1).padStart(2, '0')}`,
        input,
      );
      stored.push(next);
      return next;
    },
    update: ([ref, input]: [CredentialRef, CredentialUpdate]) => {
      updated.push({ ref, input });
      const index = stored.findIndex((entry) => entry.id === ref.id);
      if (index === -1) {
        throw new ContractError(
          'credential_missing',
          `Credential ${ref.id} is not stored.`,
        );
      }
      const current = stored[index];
      const next: CredentialDescription = {
        ...current,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.secret === undefined
          ? {}
          : { hasSecret: input.secret !== null && input.secret !== '' }),
      };
      stored[index] = next;
      return next;
    },
  });

  const world = createTestServices({
    bundle: { id: 'claude-login' },
    provide: [secrets],
  });

  try {
    const cleanup = createActivate({ deps })({ services: world.services });
    let login: ClaudeLogin | undefined;
    world.services.whenAvailable(ClaudeLoginV1, (api) => {
      login = api;
    });
    if (login === undefined) {
      throw new Error(
        'Expected the activated bundle to provide claude.login/v1.',
      );
    }
    return {
      world,
      secrets: {
        created,
        updated,
        // Live by getter: the count grows as later sign-ins list the store,
        // where a copied number would stay the one this return saw.
        get listed() {
          return listed;
        },
      },
      providers: login,
      deactivate: async () => {
        await cleanup();
      },
    };
  } catch (error) {
    await world.dispose();
    throw error;
  }
};
