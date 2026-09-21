import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  messageFromErrorEnvelope,
  retryWhileActive,
  workspaceApi,
  WorkspaceError,
} from '../src/workspace/api';
import { name, senderIsAllowed } from '../src/workspace/validation';

describe('workspace IPC origin', () => {
  const rendererUrl = 'http://localhost:4200/';

  test('accepts only the exact renderer URL', () => {
    assert.equal(senderIsAllowed(rendererUrl, rendererUrl), true);
    assert.equal(
      senderIsAllowed('http://localhost:4200/other', rendererUrl),
      false,
    );
    assert.equal(senderIsAllowed(undefined, rendererUrl), false);
  });
});

describe('workspace IPC validation', () => {
  test('accepts a trimmed name containing 80 Unicode code points', () => {
    assert.equal(name(`  ${'😀'.repeat(80)}  `), '😀'.repeat(80));
  });

  test('rejects names over 80 Unicode code points', () => {
    assert.throws(
      () => name('😀'.repeat(81)),
      (error) =>
        error instanceof WorkspaceError &&
        error.message === 'Enter a name between 1 and 80 characters.',
    );
  });

  test('rejects a name containing a null character', () => {
    assert.throws(() => name('unsafe\0name'), WorkspaceError);
  });
});

describe('HTTP error envelope', () => {
  test('preserves the backend message from a valid safe envelope', () => {
    assert.equal(
      messageFromErrorEnvelope({
        error: {
          code: 'PROJECT_CONFLICT',
          message: 'Project is still active.',
        },
      }),
      'Project is still active.',
    );
  });

  test('uses a generic message for malformed envelopes', () => {
    assert.equal(
      messageFromErrorEnvelope({ error: { message: 'internal detail' } }),
      'Doric could not complete the request.',
    );
  });
});

describe('terminal deletion', () => {
  test('keeps retrying while lifecycle termination remains active', async () => {
    let attempts = 0;
    await retryWhileActive(
      async () => {
        attempts += 1;
        if (attempts <= 61) {
          throw new WorkspaceError('The project is still active.', 409);
        }
      },
      async () => undefined,
    );

    assert.equal(attempts, 62);
  });

  test('retries deletion while lifecycle termination is still settling', async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'project_active',
              message: 'The project cannot perform this operation.',
            },
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response(null, { status: 204 });
    };

    try {
      await workspaceApi.projects.delete('project-id');
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(attempts, 2);
  });
});
