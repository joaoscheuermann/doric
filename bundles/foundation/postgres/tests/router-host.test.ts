import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { isContractError } from 'bundle/contracts';

import { servePostgres } from './support/router.js';
import { isCode } from './support/storage.js';

// The host part's backends served through the router as `main.ts` serves
// them (phase 3, S38; T3.9), without a database: activation opens nothing,
// the calls that need the database fail as `internal` with the bundle's
// message and keep nothing, and the zod input check runs before the client
// is created. Always run.

const missingUrl = 'DORIC_DATABASE_URL is required.';

/** Asserts a call failed with code `internal` and the missing-URL message. */
const isMissingUrl = (error: unknown): boolean => {
  assert.ok(isContractError(error), `expected a ContractError: ${error}`);
  assert.equal(error.code, 'internal', error.message);
  assert.equal(error.message, missingUrl);

  return true;
};

const open = async (t: TestContext) => {
  const served = await servePostgres({ environment: {} });

  t.after(() => served.dispose());

  return served;
};

void test('with an empty environment, the router serves health and capabilities and fails identity and secrets as internal, keeping nothing', async (t) => {
  const served = await open(t);

  // Activation opened nothing: no client, so no startup line.
  assert.deepEqual(served.logs, []);

  assert.equal((await served.storage.health()).status, 'ok');

  const capabilities = await served.storage.capabilities();

  assert.deepEqual(
    {
      maxBatch: capabilities.maxBatch,
      maxDocumentBytes: capabilities.maxDocumentBytes,
      maxAppendBytes: capabilities.maxAppendBytes,
    },
    { maxBatch: 10_000, maxDocumentBytes: 268_435_455, maxAppendBytes: 268_435_455 },
  );

  await assert.rejects(served.storage.identity(), isMissingUrl);
  await assert.rejects(served.secrets.list(), isMissingUrl);
  // The failed creation is not kept: the next call reads the variable again.
  await assert.rejects(served.storage.identity(), isMissingUrl);

  assert.deepEqual(served.logs, []);
});

void test('a malformed argument is refused as invalid_input before the database is needed', async (t) => {
  const served = await open(t);

  await assert.rejects(
    // The backend itself, not the router client: protobuf would turn 42 into "42".
    served.backends.storage.get({ type: 42, id: 'x' } as unknown as { type: string; id: string }),
    isCode('invalid_input'),
  );
  assert.deepEqual(served.logs, []);
});
