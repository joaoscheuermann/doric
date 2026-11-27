// The harness of `claude-login`'s host part through the router (phase 3,
// slice S50b): `claude.login/v1` served by `createTestRouter` as
// `src/host/main.ts` serves it (`createClaudeLoginService`, `activate`,
// `deactivate`), with a recording fake of `secrets/v1` (`Create`, `List`,
// `Update`) and the OAuth seams of the kernel tests: the real callback server
// on a free port and a faked token endpoint, so a test "is the browser" by
// requesting the redirect URI the authorization URL names.

import dns from 'node:dns';
import type { TestContext } from 'node:test';

import type { DescService, JsonValue } from '@bufbuild/protobuf';
import { toJson } from '@bufbuild/protobuf';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { type CallScope, ContractError, callOf } from 'bundle/contracts';
import {
  CreateRequestSchema,
  SecretsService,
  UpdateRequestSchema,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import type { ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import {
  createClaudeOAuth,
  createLocalCallbackServer,
  type LocalCallbackServerOptions,
  type OAuthHttpRequest,
  type OAuthTransport,
} from 'oauth';

import { LoginService } from '../../src/contracts/gen/doric/claude/login/v1/login_pb.js';
import type { ClaudeLoginDeps } from '../../src/host/login.js';
import {
  type ClaudeLoginServiceHandle,
  createClaudeLoginService,
} from '../../src/host/rpc/login.js';

/** The services `claude-login`'s host part declares it calls. */
export const REQUIRES = [SecretsService.typeName];

/** A credential's public view, as `secrets/v1` answers it in JSON. */
export interface StoredCredential {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly hasSecret: boolean;
}

/** What the fake `secrets/v1` recorded, in call order. */
export interface SecretsRecord {
  /** `Create` requests, as JSON. */
  readonly creates: JsonValue[];
  /** `Update` requests, as JSON. */
  readonly updates: JsonValue[];
  /** How many `List` calls arrived. */
  lists: number;
  /** The scope of every `secrets/v1` call, in order. */
  readonly scopes: (CallScope | undefined)[];
}

export interface HarnessOptions {
  /** The OAuth seams `createClaudeLoginService({ deps })` is given. */
  readonly deps?: ClaudeLoginDeps;
  /** The credentials the fake store already holds (and `List` answers). */
  readonly stored?: readonly StoredCredential[];
  /**
   * `Create` fails with this error, whatever is stored. Without it, `Create`
   * fails `credential_name_taken` only when a stored credential has the same
   * kind and name, as the real store does.
   */
  readonly createError?: () => ContractError;
}

/** The id the fake store gives the credential its `n`th `Create` stored. */
export const createdId = (n: number): string =>
  `00000000-0000-4000-8000-9000000000${String(n).padStart(2, '0')}`;

/** A `[Service, implementation]` fake that serves only the methods given. */
const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/**
 * `claude-login`'s host part activated on a test router as `main.ts` runs it
 * (`services: [[LoginService, implementation]]`, `activate`, `deactivate`),
 * `requires` `secrets/v1`, beside a recording, stateful fake of it.
 */
export const harness = async (
  t: TestContext,
  options: HarnessOptions = {},
): Promise<{
  readonly router: TestRouter;
  readonly handle: ClaudeLoginServiceHandle;
  readonly secrets: SecretsRecord;
  /** A client of the part, with no scope or with `scope`. */
  client(scope?: CallScope): Client<typeof LoginService>;
}> => {
  const stored: StoredCredential[] = [...(options.stored ?? [])];
  const secrets: SecretsRecord = {
    creates: [],
    updates: [],
    lists: 0,
    scopes: [],
  };
  let created = 0;

  const router = createTestRouter({
    requires: REQUIRES,
    instance: { bundleId: 'claude-login' },
    fakes: [
      fakeOf(SecretsService, {
        create: (request, context) => {
          secrets.creates.push(toJson(CreateRequestSchema, request));
          secrets.scopes.push(callOf(context).scope);

          if (options.createError !== undefined) {
            throw options.createError();
          }

          if (
            stored.some(
              (entry) =>
                entry.kind === request.kind && entry.name === request.name,
            )
          ) {
            throw new ContractError(
              'credential_name_taken',
              `A credential named ${request.name} of kind ${request.kind} is already stored.`,
            );
          }

          created += 1;

          const description: StoredCredential = {
            id: createdId(created),
            kind: request.kind,
            name: request.name,
            hasSecret: request.secret !== undefined,
          };

          stored.push(description);

          return { credentialDescription: description };
        },
        list: (_request, context) => {
          secrets.lists += 1;
          secrets.scopes.push(callOf(context).scope);

          return { credentials: [...stored] };
        },
        update: (request, context) => {
          secrets.updates.push(toJson(UpdateRequestSchema, request));
          secrets.scopes.push(callOf(context).scope);

          const index = stored.findIndex(
            (entry) => entry.id === request.ref?.id,
          );
          const current = stored[index];

          if (current === undefined) {
            throw new Error(`Credential ${request.ref?.id} is not stored.`);
          }

          const next: StoredCredential = {
            ...current,
            hasSecret: (request.update?.secret ?? '') !== '',
          };

          stored[index] = next;

          return { credentialDescription: next };
        },
      }),
    ],
  });

  const handle = createClaudeLoginService({ deps: options.deps });

  t.after(() => router.control.stop());

  await router.activate({
    services: [[LoginService, handle.implementation]],
    activate: (context) => handle.activate(context),
    deactivate: () => handle.deactivate(),
  });

  return {
    router,
    handle,
    secrets,
    client: (scope) =>
      router.client(LoginService, scope === undefined ? {} : { scope }),
  };
};

/**
 * A token endpoint that answers every exchange with the given access token,
 * recording each exchange request in `exchanges`.
 */
export const tokenEndpoint =
  (
    accessToken: string,
    exchanges: OAuthHttpRequest[] = [],
  ): (() => OAuthTransport) =>
  () => ({
    request: async (request) => {
      exchanges.push(request);

      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh',
          token_type: 'Bearer',
          expires_in: 31536000,
        }),
      };
    },
  });

/** The real callback server on a free port, recording the options asked for. */
export const freePort =
  (asked: LocalCallbackServerOptions[] = []): ClaudeLoginDeps['createServer'] =>
  (options) => {
    asked.push(options);

    return createLocalCallbackServer({ ...options, port: 0 });
  };

/** The real Claude OAuth client, recording each URL it opens. */
export const recordingOAuth =
  (opened: string[]): ClaudeLoginDeps['createOAuth'] =>
  (options) =>
    createClaudeOAuth({
      ...options,
      browserOpener: async (url) => {
        opened.push(url);
        await options.browserOpener?.(url);
      },
    });

/**
 * Resolves `localhost` as the callback server's `listen` did, so a host
 * without a global IPv6 address still reaches it.
 */
const browse = async (target: string): Promise<Response> => {
  const url = new URL(target);
  const { address, family } = await dns.promises.lookup(url.hostname);

  url.hostname = family === 6 ? `[${address}]` : address;

  return fetch(url);
};

/** What the browser does once the user approves: request the redirect URI. */
export const approve = async (
  authorizeUrl: string,
  answer: Readonly<Record<string, string>> = { code: 'code-1' },
): Promise<number> => {
  const url = new URL(authorizeUrl);
  const callback = new URL(url.searchParams.get('redirect_uri') ?? '');

  callback.searchParams.set('state', url.searchParams.get('state') ?? '');

  for (const [key, value] of Object.entries(answer)) {
    callback.searchParams.set(key, value);
  }

  return (await browse(callback.href)).status;
};

/** Whether the redirect URI an authorization URL names still answers. */
export const callbackListening = async (
  authorizeUrl: string,
): Promise<boolean> => {
  const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri');

  try {
    await browse(redirect ?? '');

    return true;
  } catch {
    return false;
  }
};

/**
 * Whether the callback server closes within `ms`: it closes as the aborted
 * authorization unwinds, a few ticks after the cancel.
 */
export const callbackCloses = async (
  authorizeUrl: string,
  ms = 2_000,
): Promise<boolean> => {
  const until = Date.now() + ms;

  while (Date.now() < until) {
    if (!(await callbackListening(authorizeUrl))) {
      return true;
    }

    await new Promise((done) => setTimeout(done, 10));
  }

  return false;
};
