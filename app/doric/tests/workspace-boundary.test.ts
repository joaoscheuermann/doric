import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  messageFromErrorEnvelope,
  retryWhileActive,
  workspaceApi,
  WorkspaceError,
} from '../src/workspace/api';
import {
  name,
  prompt,
  senderIsAllowed,
  sequence,
} from '../src/workspace/validation';

const thread = {
  id: 'thread-id',
  name: 'Main',
  projectId: 'project-id',
  state: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

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

  test('accepts non-empty prompts without changing their content', () => {
    assert.equal(prompt('  do the work  '), '  do the work  ');
  });

  test('rejects empty prompts and invalid event cursors', () => {
    assert.throws(() => prompt(' \n '), WorkspaceError);
    assert.throws(() => sequence(-1), WorkspaceError);
    assert.throws(() => sequence(1.5), WorkspaceError);
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

describe('Thread HTTP boundary', () => {
  test('gets a Thread and submits a prompt through the existing routes', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return requests.length === 1
        ? Response.json(thread)
        : Response.json({ promptId: 'prompt-id' }, { status: 202 });
    };

    try {
      assert.deepEqual(await workspaceApi.threads.get('thread/id'), thread);
      assert.deepEqual(
        await workspaceApi.threads.prompt('thread/id', 'Do the work'),
        { promptId: 'prompt-id' },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests[0]?.url, 'http://127.0.0.1:3000/threads/thread%2Fid');
    assert.equal(requests[0]?.init?.method, undefined);
    assert.equal(
      requests[1]?.url,
      'http://127.0.0.1:3000/threads/thread%2Fid/prompt',
    );
    assert.equal(requests[1]?.init?.method, 'POST');
    assert.equal(requests[1]?.init?.body, '{"prompt":"Do the work"}');
  });

  test('rewinds a prompt through the existing route', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ promptId: 'next-prompt' }, { status: 202 });
    };

    try {
      assert.deepEqual(
        await workspaceApi.threads.rewind('thread-id', 'prompt-id', 'edited'),
        { promptId: 'next-prompt' },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(
      requests[0]?.url,
      'http://127.0.0.1:3000/threads/thread-id/rewind',
    );
    assert.equal(requests[0]?.init?.method, 'POST');
    assert.equal(
      requests[0]?.init?.body,
      '{"promptId":"prompt-id","prompt":"edited"}',
    );
  });

  test('reports a deleted Thread as absent rather than as a failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json(
        {
          error: {
            code: 'thread_missing',
            message: 'The Thread does not exist.',
          },
        },
        { status: 404 },
      );

    try {
      assert.equal(await workspaceApi.threads.get('thread-id'), undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects malformed successful Thread and prompt responses', async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      Response.json({ ...thread, projectId: 42 }),
      Response.json({ accepted: true }, { status: 202 }),
    ];
    globalThis.fetch = async () => responses.shift() as Response;

    try {
      await assert.rejects(
        workspaceApi.threads.get('thread-id'),
        (error) =>
          error instanceof WorkspaceError &&
          error.message === 'Doric returned an invalid response.',
      );
      await assert.rejects(
        workspaceApi.threads.prompt('thread-id', 'work'),
        (error) =>
          error instanceof WorkspaceError &&
          error.message === 'Doric returned an invalid response.',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
