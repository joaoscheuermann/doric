import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express, { type Express } from 'express';

import { createSessionsRouter } from '../src/routes/sessions.js';

test('creates a prompt-free session with its stable SSH link', async () => {
  const host = await serveSessions({ create: async () => session });

  try {
    const created = await fetch(`${host.url}/sessions`, { method: 'POST' });

    assert.equal(created.status, 202);

    assert.deepEqual(await created.json(), {
      ...session,
      ssh: { href: `/sessions/${session.id}/ssh` },
    });
  } finally {
    await host.close();
  }
});

test('returns the same public representation from session list and detail', async () => {
  const host = await serveSessions({
    find: async () => session,
    list: async () => ({ sessions: [session] }),
  });

  try {
    const listed = await fetch(`${host.url}/sessions`);
    const detail = await fetch(`${host.url}/sessions/${session.id}`);
    const detailBody = (await detail.json()) as Record<string, unknown>;

    assert.deepEqual(detailBody, session);

    assert.equal('result' in detailBody, false);

    assert.equal('prompt' in detailBody, false);

    assert.deepEqual(
      ((await listed.json()) as { sessions: unknown[] }).sessions[0],
      detailBody,
    );
  } finally {
    await host.close();
  }
});

test('accepts a session prompt and returns its identifier', async () => {
  const host = await serveSessions({
    prompt: async () => ({ status: 'accepted', promptId }) as const,
  });

  try {
    const prompted = await fetch(`${host.url}/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'inspect the sandbox' }),
    });

    assert.equal(prompted.status, 202);

    assert.deepEqual(await prompted.json(), { promptId });
  } finally {
    await host.close();
  }
});

test('uses an exclusive event cursor and prohibits replay caching', async () => {
  const cursors: number[] = [];

  const host = await serveSessions({
    events: async (_id: string, sequence: number) => {
      cursors.push(sequence);

      return { events: [event], lastSequence: 2 };
    },
  });

  try {
    const events = await fetch(
      `${host.url}/sessions/${session.id}/events?afterSequence=1`,
    );

    assert.equal(events.status, 200);

    assert.equal(events.headers.get('cache-control'), 'no-store');

    assert.deepEqual(await events.json(), {
      events: [event],
      lastSequence: 2,
    });

    await fetch(`${host.url}/sessions/${session.id}/events`);

    assert.deepEqual(cursors, [1, 0]);
  } finally {
    await host.close();
  }
});

test('rejects a prompt with an invalid session identifier', async () => {
  const host = await serveSessions({});

  try {
    await expectError(
      `${host.url}/sessions/not-a-uuid/prompt`,
      400,
      'invalid_session_id',
      { method: 'POST' },
    );
  } finally {
    await host.close();
  }
});

test('rejects an empty session prompt', async () => {
  const host = await serveSessions({});

  try {
    await expectError(
      `${host.url}/sessions/${session.id}/prompt`,
      422,
      'invalid_prompt',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: ' ' }),
      },
    );
  } finally {
    await host.close();
  }
});

test('maps inactive and missing prompt targets to stable errors', async (t) => {
  let status: 'inactive' | 'missing' = 'inactive';
  const host = await serveSessions({ prompt: async () => ({ status }) });

  const cases = [
    {
      name: 'returns session_inactive when the session no longer accepts prompts',
      status: 'inactive',
      http: 409,
      code: 'session_inactive',
    },
    {
      name: 'returns session_not_found when the prompt target is missing',
      status: 'missing',
      http: 404,
      code: 'session_not_found',
    },
  ] as const;

  try {
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        status = entry.status;

        await expectError(
          `${host.url}/sessions/${session.id}/prompt`,
          entry.http,
          entry.code,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'work' }),
          },
        );
      });
    }
  } finally {
    await host.close();
  }
});

test('rejects a negative event cursor', async () => {
  const host = await serveSessions({});

  try {
    await expectError(
      `${host.url}/sessions/${session.id}/events?afterSequence=-1`,
      400,
      'invalid_event_cursor',
    );
  } finally {
    await host.close();
  }
});

test('rejects a session page above the public limit', async () => {
  const host = await serveSessions({});

  try {
    await expectError(`${host.url}/sessions?limit=101`, 400, 'invalid_page');
  } finally {
    await host.close();
  }
});

test('returns ready session SSH access without permitting caches', async () => {
  const service = {
    ssh: async () =>
      ({ status: 'ready', vmId: 'vm/1', ssh: sshAccess }) as const,
  };
  const host = await serveSessions(service);

  try {
    const response = await fetch(`${host.url}/sessions/${session.id}/ssh`);

    assert.equal(response.status, 200);

    assert.equal(response.headers.get('cache-control'), 'no-store');

    assert.deepEqual(await response.json(), {
      status: 'ready',
      vmId: 'vm/1',
      ssh: sshAccess,
      href: '/vms/vm%2F1/ssh',
    });
  } finally {
    await host.close();
  }
});

test('maps unavailable session SSH states to stable responses', async (t) => {
  let status: 'pending' | 'unavailable' | 'expired' | 'missing' = 'pending';
  const service = { ssh: async () => ({ status }) };
  const host = await serveSessions(service);

  const cases = [
    {
      name: 'returns a retryable response while SSH is pending',
      status: 'pending',
      http: 202,
    },
    {
      name: 'returns session_ssh_unavailable when SSH is unavailable',
      status: 'unavailable',
      http: 409,
      code: 'session_ssh_unavailable',
    },
    {
      name: 'returns session_ssh_expired after SSH access expires',
      status: 'expired',
      http: 410,
      code: 'session_ssh_expired',
    },
    {
      name: 'returns session_not_found for a missing SSH session',
      status: 'missing',
      http: 404,
      code: 'session_not_found',
    },
  ] as const;

  try {
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        status = entry.status;

        const response = await fetch(`${host.url}/sessions/${session.id}/ssh`);

        assert.equal(response.status, entry.http);

        assert.equal(response.headers.get('cache-control'), 'no-store');

        if ('code' in entry) {
          assert.equal(
            ((await response.json()) as { error: { code: string } }).error.code,
            entry.code,
          );
        } else {
          assert.deepEqual(await response.json(), { status: 'pending' });

          assert.equal(response.headers.get('retry-after'), '1');
        }
      });
    }
  } finally {
    await host.close();
  }
});

test('terminates an existing session', async () => {
  const host = await serveSessions({ terminate: async () => session });

  try {
    const terminated = await fetch(
      `${host.url}/sessions/${session.id}/terminate`,
      { method: 'POST' },
    );

    assert.equal(terminated.status, 200);

    assert.deepEqual(await terminated.json(), session);
  } finally {
    await host.close();
  }
});

test('reports a missing termination target', async () => {
  const host = await serveSessions({ terminate: async () => undefined });

  try {
    await expectError(
      `${host.url}/sessions/${session.id}/terminate`,
      404,
      'session_not_found',
      { method: 'POST' },
    );
  } finally {
    await host.close();
  }
});

test('deletes only terminal sessions through stable HTTP outcomes', async (t) => {
  let outcome: 'deleted' | 'active' | 'missing' = 'deleted';
  const service = { delete: async () => outcome };
  const host = await serveSessions(service);

  const cases = [
    {
      name: 'returns an empty success after deleting a terminal session',
      outcome: 'deleted',
      http: 204,
    },
    {
      name: 'returns session_active when deletion targets an active session',
      outcome: 'active',
      http: 409,
      code: 'session_active',
    },
    {
      name: 'returns session_not_found when deletion targets a missing session',
      outcome: 'missing',
      http: 404,
      code: 'session_not_found',
    },
  ] as const;

  try {
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        outcome = entry.outcome;

        const response = await fetch(`${host.url}/sessions/${session.id}`, {
          method: 'DELETE',
        });

        assert.equal(response.status, entry.http);

        if ('code' in entry) {
          assert.equal(
            ((await response.json()) as { error: { code: string } }).error.code,
            entry.code,
          );
        } else {
          assert.equal(await response.text(), '');
        }
      });
    }
  } finally {
    await host.close();
  }
});

const session = {
  id: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601',
  state: 'queued',
  configRevision: 1,
  lastSequence: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';

const event = {
  sessionId: session.id,
  promptId,
  sequence: 2,
  type: 'reasoning.delta',
  event: { type: 'reasoning.delta', delta: 'reasoning' },
  createdAt: new Date(1000).toISOString(),
};

const sshAccess = {
  host: '127.0.0.1',
  port: 2200,
  username: 'root' as const,
  privateKey: 'private-key',
  knownHosts: '[127.0.0.1]:2200 ssh-ed25519 host-key',
  hostKeyFingerprint: 'SHA256:test',
};

const expectError = async (
  url: string,
  status: number,
  code: string,
  init?: RequestInit,
) => {
  const response = await fetch(url, init);

  assert.equal(response.status, status);

  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    code,
  );
};

const serveSessions = (service: unknown) => {
  const app = express();

  app.use(express.json());

  app.use('/sessions', createSessionsRouter(service as never));

  return serve(app);
};

const serve = async (app: Express) => {
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();

  assert.ok(address !== null && typeof address === 'object');

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      ),
  };
};
