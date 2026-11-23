// `claude-login`'s host part through the router (phase 3, slice S50b, tests
// L1–L14): `claude.login/v1` served by `createClaudeLoginService` answers as
// the kernel entry did, and stores the authorization through a routed
// `secrets/v1` client that carries the `Finish` call's scope. The OAuth
// seams are the kernel tests': the real callback server on a free port and
// a faked token endpoint; the test "is the browser".

import assert from 'node:assert/strict';
import test from 'node:test';

import { toJson } from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import {
  type CallScope,
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import {
  createLocalCallbackServer,
  type LocalCallbackServerOptions,
} from 'oauth';

import { FinishResponseSchema } from '../src/contracts/gen/doric/claude/login/v1/login_pb.js';
import {
  approve,
  callbackCloses,
  createdId,
  freePort,
  harness,
  recordingOAuth,
  type StoredCredential,
  tokenEndpoint,
} from './support/router.js';

/** The Doric code of a failed call: read off a `ConnectError`, or a `ContractError`'s. */
const codeOf = (error: unknown): string => {
  if (error instanceof ConnectError) {
    return fromConnectError(error).code;
  }

  assert.ok(isContractError(error), `expected a Doric error: ${error}`);

  return error.code;
};

/** Whether a rejection carries the Doric code given. */
const refusal =
  (code: string) =>
  (error: unknown): boolean => {
    assert.equal(codeOf(error), code, String(error));

    return true;
  };

/**
 * Lets a call dispatched through the in-memory router reach the handler
 * before the next step races it (a cancel, a newer `Start`).
 */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 50));

/** The credential a first `Create` of the Claude authorization stores. */
const created = {
  id: createdId(1),
  kind: 'API_TOKEN',
  name: 'Claude',
  hasSecret: true,
};

/** A Claude credential already stored, still without a secret. */
const existing: StoredCredential = {
  id: '00000000-0000-4000-8000-000000000077',
  kind: 'API_TOKEN',
  name: 'Claude',
  hasSecret: false,
};

void test('L1: Start answers the URL the OAuth client opened, with the callback bound on 54545', async (t) => {
  const asked: LocalCallbackServerOptions[] = [];
  const opened: string[] = [];
  const h = await harness(t, {
    deps: {
      createServer: freePort(asked),
      createOAuth: recordingOAuth(opened),
      transport: tokenEndpoint('fresh-token'),
    },
  });

  const { url } = await h.client().start({});

  assert.deepEqual(opened, [url]);
  assert.equal(new URL(url).protocol, 'https:');
  assert.deepEqual(asked, [
    { host: 'localhost', port: 54545, path: '/callback' },
  ]);
});

void test('L2: Start falls back to 54546 on EADDRINUSE; any other server error, or both ports busy, fails claude_login_failed', async (t) => {
  const busy = () =>
    Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

  await t.test('54545 in use: bound on 54546', async (st) => {
    const asked: LocalCallbackServerOptions[] = [];
    const h = await harness(st, {
      deps: {
        createServer: async (options) => {
          asked.push(options);

          if (options.port === 54545) {
            throw busy();
          }

          return createLocalCallbackServer({ ...options, port: 0 });
        },
        transport: tokenEndpoint('spare'),
      },
    });

    const { url } = await h.client().start({});

    assert.ok(url.startsWith('https:'), url);
    assert.deepEqual(
      asked.map((options) => options.port),
      [54545, 54546],
    );
  });

  await t.test('another server error: claude_login_failed', async (st) => {
    const asked: LocalCallbackServerOptions[] = [];
    const h = await harness(st, {
      deps: {
        createServer: async (options) => {
          asked.push(options);

          throw Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
        },
        transport: tokenEndpoint('never'),
      },
    });

    await assert.rejects(h.client().start({}), refusal('claude_login_failed'));
    assert.deepEqual(
      asked.map((options) => options.port),
      [54545],
    );
  });

  await t.test('both ports busy: claude_login_failed', async (st) => {
    const asked: LocalCallbackServerOptions[] = [];
    const h = await harness(st, {
      deps: {
        createServer: async (options) => {
          asked.push(options);

          throw busy();
        },
        transport: tokenEndpoint('never'),
      },
    });

    await assert.rejects(h.client().start({}), refusal('claude_login_failed'));
    assert.deepEqual(
      asked.map((options) => options.port),
      [54545, 54546],
    );
  });
});

void test('L3: Finish with no Start fails claude_login_not_started and calls no secrets/v1', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('unused') },
  });

  await assert.rejects(
    h.client().finish({}),
    refusal('claude_login_not_started'),
  );
  assert.deepEqual(h.secrets.creates, []);
  assert.equal(h.secrets.lists, 0);
  assert.deepEqual(h.secrets.updates, []);
});

void test('L4: Start, the callback, Finish: one Create of the API_TOKEN Claude, answered as its description, the authorization never answered nor logged', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('fresh-token') },
  });
  const client = h.client();

  const { url } = await client.start({});
  const finished = client.finish({});

  assert.equal(await approve(url), 200);

  const answer = toJson(FinishResponseSchema, await finished);

  assert.deepEqual(answer, { credentialDescription: created });
  assert.deepEqual(h.secrets.creates, [
    { kind: 'API_TOKEN', name: 'Claude', secret: 'Bearer fresh-token' },
  ]);
  assert.equal(h.secrets.lists, 0);
  assert.deepEqual(h.secrets.updates, []);
  assert.doesNotMatch(JSON.stringify(answer), /fresh-token/);
  assert.doesNotMatch(JSON.stringify(h.router.logs), /fresh-token/);
});

void test('L5: Create failing credential_name_taken lists, then updates the listed Claude credential, and answers Update’s description', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('token-2') },
    stored: [existing],
  });
  const client = h.client();

  const { url } = await client.start({});
  const finished = client.finish({});

  await approve(url);

  assert.deepEqual(toJson(FinishResponseSchema, await finished), {
    credentialDescription: { ...existing, hasSecret: true },
  });
  assert.equal(h.secrets.creates.length, 1);
  assert.equal(h.secrets.lists, 1);
  assert.deepEqual(h.secrets.updates, [
    { ref: { id: existing.id }, update: { secret: 'Bearer token-2' } },
  ]);
});

void test('L6: name taken and no listed API_TOKEN named Claude fails credential_name_taken, with no Update', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('taken') },
    stored: [
      {
        ...existing,
        id: '00000000-0000-4000-8000-000000000078',
        kind: 'PASSWORD',
      },
      {
        ...existing,
        id: '00000000-0000-4000-8000-000000000079',
        name: 'Other',
      },
    ],
    createError: () =>
      new ContractError(
        'credential_name_taken',
        'A credential named Claude is already stored.',
      ),
  });
  const client = h.client();

  const { url } = await client.start({});
  const finished = assert.rejects(
    client.finish({}),
    refusal('credential_name_taken'),
  );

  await approve(url);
  await finished;

  assert.equal(h.secrets.lists, 1);
  assert.deepEqual(h.secrets.updates, []);
});

void test('L7: Create failing invalid_input fails Finish with invalid_input, not internal', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('refused') },
    createError: () =>
      new ContractError('invalid_input', 'The credential is not valid.'),
  });
  const client = h.client();

  const { url } = await client.start({});
  const finished = assert.rejects(client.finish({}), refusal('invalid_input'));

  await approve(url);
  await finished;
});

void test('L8: a second Finish while one waits fails claude_login_busy; the first still completes', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('once') },
  });
  const client = h.client();

  const { url } = await client.start({});
  const first = client.finish({});

  await settle();
  await assert.rejects(client.finish({}), refusal('claude_login_busy'));
  await approve(url);

  assert.deepEqual(toJson(FinishResponseSchema, await first), {
    credentialDescription: created,
  });
});

void test('L9: a Finish its caller cancels cancels the sign-in: the callback closes, nothing is stored, a later Finish fails claude_login_not_started', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('never') },
  });
  const client = h.client();
  const controller = new AbortController();

  const { url } = await client.start({});
  const finished = client.finish({}, { signal: controller.signal });

  await settle();
  controller.abort();

  await assert.rejects(finished);
  assert.ok(await callbackCloses(url), 'the callback server still answers');
  assert.deepEqual(h.secrets.creates, []);
  await assert.rejects(client.finish({}), refusal('claude_login_not_started'));
});

void test('L10: a new Start while a Finish waits fails that Finish claude_login_aborted; the second sign-in waits', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('second') },
  });
  const client = h.client();

  const first = await client.start({});
  const abandoned = assert.rejects(
    client.finish({}),
    refusal('claude_login_aborted'),
  );

  await settle();

  const second = await client.start({});

  await abandoned;
  assert.ok(
    await callbackCloses(first.url),
    'the first callback still answers',
  );

  const finished = client.finish({});

  await approve(second.url);

  assert.deepEqual(toJson(FinishResponseSchema, await finished), {
    credentialDescription: created,
  });
  assert.equal(h.secrets.creates.length, 1);
});

void test('L11: a sign-in nobody finishes within deps.timeoutMs closes its callback; Finish then fails claude_login_not_started', async (t) => {
  const h = await harness(t, {
    deps: {
      createServer: freePort(),
      transport: tokenEndpoint('late'),
      timeoutMs: 20,
    },
  });
  const client = h.client();

  const { url } = await client.start({});

  assert.ok(await callbackCloses(url), 'the callback server still answers');
  await assert.rejects(client.finish({}), refusal('claude_login_not_started'));
});

void test('L12: a failed authorization fails Finish claude_login_failed and calls no secrets/v1', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('never') },
  });
  const client = h.client();

  const { url } = await client.start({});
  const finished = assert.rejects(
    client.finish({}),
    refusal('claude_login_failed'),
  );

  await approve(url, { error: 'access_denied' });
  await finished;

  assert.deepEqual(h.secrets.creates, []);
  assert.equal(h.secrets.lists, 0);
  assert.deepEqual(h.secrets.updates, []);
});

void test('L13: stopping the bundle with a sign-in waiting closes its callback server', async (t) => {
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('gone') },
  });

  const { url } = await h.client().start({});

  await h.router.control.stop();

  assert.ok(await callbackCloses(url), 'the callback server still answers');
});

void test('L14: the secrets/v1 calls carry the Finish call’s scope', async (t) => {
  const scope: CallScope = {
    projectId: 'project-1',
    threadId: 'thread-1',
    promptId: 'prompt-1',
  };
  const h = await harness(t, {
    deps: { createServer: freePort(), transport: tokenEndpoint('scoped') },
    stored: [existing],
  });
  const client = h.client(scope);

  const { url } = await client.start({});
  const finished = client.finish({});

  await approve(url);
  await finished;

  assert.deepEqual(h.secrets.scopes, [scope, scope, scope]);
});
