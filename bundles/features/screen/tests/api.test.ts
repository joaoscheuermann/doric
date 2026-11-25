// The window's screen call from slice S65d: `createScreenApi` over the
// generated `SessionsService` client, whose `Attach` is served by a fake
// `HostClients` (`./support/connect.js`). The tests read what the client part
// sends (the request's `projectId` and the call's `{projectId}` scope) and
// what it answers: today's `ScreenAttach`, or `null` when no answer arrived.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';

import { createScreenApi, screenApiMessages } from '../src/client/api.js';
import {
  type AttachResponseSchema,
  SessionsService,
} from '../src/contracts/gen/doric/screen/sessions/v2/sessions_pb.js';
import type { ScreenAttach } from '../src/contracts/index.js';
import { fakeClientServices, fakeHostClients } from './support/connect.js';

/** The client part's `attach` over a host that answers `impl`. */
const apiOver = (impl: Partial<ServiceImpl<typeof SessionsService>>) => {
  const { hostClients, calls } = fakeHostClients((router) => {
    router.service(SessionsService, impl);
  });
  const { services } = fakeClientServices({ bundleId: 'screen', hostClients });

  return {
    api: createScreenApi((projectId) =>
      services.use(SessionsService, { projectId }),
    ),
    calls,
  };
};

/** An `AttachResponse` with the `status` oneof answered by `value`. */
const answered = (
  value: NonNullable<MessageInitShape<typeof AttachResponseSchema>['status']>,
): Partial<ServiceImpl<typeof SessionsService>> => ({
  attach: () => ({ status: value }),
});

const ready = (projectId: string): ScreenAttach => ({
  status: 'ready',
  path: `/screen/${projectId}/`,
  display: ':100',
});

test('a ready answer is today’s ScreenAttach, and the call carries the Project scope', async () => {
  const { api, calls } = apiOver(
    answered({
      case: 'ready',
      value: { path: '/screen/p1/', display: ':100' },
    }),
  );

  assert.deepEqual(await api.attach('p1'), ready('p1'));
  assert.deepEqual(calls, [
    {
      method: `${SessionsService.typeName}/Attach`,
      part: 'screen',
      scope: { projectId: 'p1' },
    },
  ]);
});

test('the request names the Project too', async () => {
  const requests: string[] = [];
  const { api } = apiOver({
    attach: (request) => {
      requests.push(request.projectId);

      return {
        status: {
          case: 'ready',
          value: { path: '/screen/p1/', display: ':100' },
        },
      };
    },
  });

  await api.attach('p1');

  assert.deepEqual(requests, ['p1']);
});

test('a pending answer and an unavailable one are today’s statuses', async () => {
  const pending = apiOver(answered({ case: 'pending', value: {} }));
  assert.deepEqual(await pending.api.attach('p1'), { status: 'pending' });

  for (const reason of ['sandbox', 'missing-xpra', 'start-failed'] as const) {
    const unavailable = apiOver(
      answered({ case: 'unavailable', value: { reason } }),
    );

    assert.deepEqual(await unavailable.api.attach('p1'), {
      status: 'unavailable',
      reason,
    });
  }
});

test('each attach of a Project resolves its own scope', async () => {
  const { api, calls } = apiOver(
    answered({
      case: 'ready',
      value: { path: '/screen/p1/', display: ':100' },
    }),
  );

  await api.attach('p1');
  await api.attach('p2');

  assert.deepEqual(
    calls.map(({ scope }) => scope),
    [{ projectId: 'p1' }, { projectId: 'p2' }],
  );
});

test('an invalid identifier never reaches the host', async () => {
  const { api, calls } = apiOver(answered({ case: 'pending', value: {} }));

  for (const value of ['', 'x'.repeat(201), 'a\0b']) {
    await assert.rejects(
      api.attach(value),
      new RegExp(screenApiMessages.invalidIdentifier),
    );
  }

  assert.equal(calls.length, 0);
});

test('a lost bridge answers no answer', async () => {
  const { api } = apiOver({
    attach: () => {
      throw new ContractError('unavailable', 'the bridge is gone');
    },
  });

  assert.equal(await api.attach('p1'), null);
});

test('any other failure answers no answer too', async () => {
  const { api } = apiOver({
    attach: () => {
      throw new ContractError('internal', 'boom');
    },
  });

  assert.equal(await api.attach('p1'), null);
});

test('an answer that is not a status is dropped', async () => {
  const { api } = apiOver({
    attach: () =>
      ({
        status: { case: 'unknown', value: {} },
        url: 'http://127.0.0.1:1/',
      }) as never,
  });

  assert.equal(await api.attach('p1'), null);
});
