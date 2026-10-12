import assert from 'node:assert/strict';
import test from 'node:test';

import { type Log, LogV1, SecretsV1 } from 'bundle/contracts';

import { boot, core, probe } from './support/host.js';

// D-L: no log record shows a secret the host holds (stage 2+3 design §5.6).

const writer = () => {
  let log: Log | undefined;

  return {
    bundle: probe('writer', {
      requires: ['log/v1@^1.0.0'],
      activate: ({ services }) => {
        log = services.use(LogV1);
      },
    }),
    get log(): Log {
      assert.ok(log);

      return log;
    },
  };
};

const stored = {
  rows: [
    { id: 'c-1', kind: 'API_TOKEN' as const, name: 'key', secret: 'sk-stored' },
    { id: 'c-2', kind: 'API_TOKEN' as const, name: 'none', secret: '' },
  ],
};

void test('a stored or added secret is redacted in the message and in nested fields', async () => {
  const bundle = writer();
  const host = await boot([await core(), bundle.bundle], {
    memory: { secrets: stored },
  });

  try {
    const secrets = host.platform.services.use(SecretsV1);

    await secrets.list();
    secrets.view().addRedaction('ghp-added');

    bundle.log.warn('pushing with sk-stored and ghp-added', {
      attempt: 2,
      request: {
        headers: { authorization: 'Bearer sk-stored' },
        tokens: ['ghp-added', 'plain'],
      },
    });

    const record = host.records.find(({ level }) => level === 'warn');

    assert.ok(record);
    assert.equal(record.message, 'pushing with [REDACTED] and [REDACTED]');
    assert.deepEqual(record.fields, {
      attempt: 2,
      request: {
        headers: { authorization: 'Bearer [REDACTED]' },
        tokens: ['[REDACTED]', 'plain'],
      },
    });
    assert.equal(JSON.stringify(record).includes('sk-stored'), false);
    assert.equal(JSON.stringify(record).includes('ghp-added'), false);
  } finally {
    await host.close();
  }
});

void test('a record logged before the credentials load is still written', async () => {
  const bundle = writer();
  const host = await boot([await core(), bundle.bundle], {
    memory: { secrets: stored },
  });

  try {
    bundle.log.info('starting', { step: 1 });

    const record = host.records.find(({ message }) => message === 'starting');

    assert.deepEqual(record?.fields, { step: 1 });
  } finally {
    await host.close();
  }
});

void test('a secret inside an Error or a class instance is redacted in the fields', async () => {
  const bundle = writer();
  const host = await boot([await core(), bundle.bundle], {
    memory: { secrets: stored },
  });

  try {
    await host.platform.services.use(SecretsV1).list();

    class Request {
      constructor(readonly auth: string) {}
    }

    bundle.log.error('boom', {
      error: Object.assign(new Error('failed sk-stored'), {
        request: { auth: 'Bearer sk-stored' },
      }),
      cause: new Error('outer', { cause: new Error('inner sk-stored') }),
      request: new Request('Bearer sk-stored'),
    });

    const record = host.records.find(({ level }) => level === 'error');

    assert.ok(record);
    const fields = record.fields as {
      error: { message: string; request: { auth: string } };
      request: { auth: string };
    };

    assert.equal(fields.error.message, 'failed [REDACTED]');
    assert.equal(fields.error.request.auth, 'Bearer [REDACTED]');
    assert.equal(fields.request.auth, 'Bearer [REDACTED]');
    assert.equal(JSON.stringify(record).includes('sk-stored'), false);
  } finally {
    await host.close();
  }
});
