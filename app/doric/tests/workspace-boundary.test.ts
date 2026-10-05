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
  relativePath,
  senderIsAllowed,
  sequence,
  workingDirectory,
} from '../src/workspace/validation';

const thread = {
  id: 'thread-id',
  name: 'Main',
  projectId: 'project-id',
  state: 'ready',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('workspace IPC origin', () => {
  const allowedUrls = [
    'http://localhost:4200/',
    'http://localhost:4200/settings.html',
  ];

  test('accepts only the exact allowed window URLs', () => {
    assert.equal(senderIsAllowed(allowedUrls[0], allowedUrls), true);
    assert.equal(senderIsAllowed(allowedUrls[1], allowedUrls), true);
    assert.equal(
      senderIsAllowed('http://localhost:4200/other', allowedUrls),
      false,
    );
    assert.equal(senderIsAllowed(undefined, allowedUrls), false);
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

  test('accepts a workspace-relative path and the workspace root', () => {
    assert.equal(relativePath('src/workspace/api.ts'), 'src/workspace/api.ts');
    assert.equal(relativePath(''), '');
    assert.equal(relativePath(undefined), '');
  });

  test('rejects an absolute workspace path', () => {
    assert.throws(() => relativePath('/etc/passwd'), WorkspaceError);
  });

  test('rejects a workspace path containing a parent segment', () => {
    assert.throws(() => relativePath('../secrets'), WorkspaceError);
    assert.throws(() => relativePath('src/../../secrets'), WorkspaceError);
  });

  test('rejects a workspace path containing a null character', () => {
    assert.throws(() => relativePath('src/unsafe\0name'), WorkspaceError);
  });

  test('rejects a workspace path over 4096 characters', () => {
    assert.equal(relativePath('a'.repeat(4096)).length, 4096);
    assert.throws(() => relativePath('a'.repeat(4097)), WorkspaceError);
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

  test('resumes a paused prompt through the existing route', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json(thread);
    };

    try {
      assert.deepEqual(
        await workspaceApi.threads.resume('thread/id', 'prompt-id'),
        thread,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(
      requests[0]?.url,
      'http://127.0.0.1:3000/threads/thread%2Fid/resume',
    );
    assert.equal(requests[0]?.init?.method, 'POST');
    assert.equal(requests[0]?.init?.body, '{"promptId":"prompt-id"}');
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

  test('moves a Thread working directory and reads its Git summary', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return requests.length === 1
        ? Response.json({ ...thread, cwd: '/workspace/doric', cwdRepo: 'git' })
        : Response.json({
            repo: true,
            root: '/workspace/doric',
            head: 'main',
            detached: false,
            unborn: false,
            upstream: null,
            ahead: 0,
            behind: 0,
            dirty: { staged: 1, modified: 2, untracked: 3 },
            conflicted: 0,
            operation: 'rebase',
            worktree: false,
            shallow: false,
            stash: 1,
            submodules: 0,
          });
    };

    try {
      assert.deepEqual(
        await workspaceApi.threads.setCwd('thread-id', '/workspace/doric'),
        { ...thread, cwd: '/workspace/doric', cwdRepo: 'git' },
      );
      assert.deepEqual(await workspaceApi.threads.git('thread-id'), {
        repo: true,
        root: '/workspace/doric',
        head: 'main',
        detached: false,
        unborn: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        dirty: { staged: 1, modified: 2, untracked: 3 },
        conflicted: 0,
        operation: 'rebase',
        worktree: false,
        shallow: false,
        stash: 1,
        submodules: 0,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requests[0]?.url, 'http://127.0.0.1:3000/threads/thread-id');
    assert.equal(requests[0]?.init?.method, 'PATCH');
    assert.equal(requests[0]?.init?.body, '{"cwd":"/workspace/doric"}');
    assert.equal(
      requests[1]?.url,
      'http://127.0.0.1:3000/threads/thread-id/git',
    );
  });

  test('rejects a malformed Git summary and a Thread without a working directory', async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      Response.json({ repo: true, root: '/workspace' }),
      Response.json({ ...thread, cwd: 7 }),
    ];
    globalThis.fetch = async () => responses.shift() as Response;

    try {
      await assert.rejects(
        workspaceApi.threads.git('thread-id'),
        WorkspaceError,
      );
      await assert.rejects(
        workspaceApi.threads.get('thread-id'),
        WorkspaceError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects a working directory that is not a path a sandbox could hold', () => {
    assert.equal(
      workingDirectory('/workspace/doric/src'),
      '/workspace/doric/src',
    );
    assert.equal(workingDirectory('doric'), 'doric');
    assert.throws(() => workingDirectory(''), WorkspaceError);
    assert.throws(() => workingDirectory('   '), WorkspaceError);
    assert.throws(() => workingDirectory('a\0b'), WorkspaceError);
    assert.throws(() => workingDirectory('a'.repeat(4097)), WorkspaceError);
    assert.throws(() => workingDirectory(7), WorkspaceError);
  });
});

/** Stubs `fetch` with one answer and restores it afterwards. */
const withAnswer = async <Value>(
  answer: Response,
  run: () => Promise<Value>,
): Promise<Value> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => answer;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

describe('Project filesystem HTTP boundary', () => {
  test('preserves Git metadata and individual comparison text across the host boundary', async () => {
    const change = {
      path: 'new\nname.ts',
      originalPath: 'old name.ts',
      status: 'renamed',
      staged: true,
      unstaged: false,
      indexStatus: 'R',
      worktreeStatus: ' ',
    };
    const changes = await withAnswer(
      Response.json({
        repositories: [
          { path: 'repo', changes: [change], added: 12, removed: 7 },
        ],
      }),
      () => workspaceApi.projects.changes('project-id'),
    );
    assert.equal(changes.status, 'ready');
    if (changes.status !== 'ready') throw new Error('Expected changes');
    assert.deepEqual(changes.changes.repositories[0]?.changes[0], change);
    assert.equal(changes.changes.repositories[0]?.added, 12);
    assert.equal(changes.changes.repositories[0]?.removed, 7);
    const value = {
      ...change,
      repository: 'repo',
      original: 'before\n',
      modified: 'after\n',
      binary: false,
      truncated: false,
    };
    const diff = await withAnswer(Response.json(value), () =>
      workspaceApi.projects.fileDiff('project-id', 'repo', change.path),
    );
    assert.equal(diff.status, 'ready');
    if (diff.status !== 'ready') throw new Error('Expected diff');
    assert.deepEqual(diff.diff, value);
  });
  test('rejects malformed change metadata instead of exposing it to the renderer', async () => {
    await assert.rejects(
      withAnswer(
        Response.json({
          repositories: [
            {
              path: '',
              added: 1,
              removed: 0,
              changes: [{ path: 'a.ts', status: 'modified', staged: 'yes' }],
            },
          ],
        }),
        () => workspaceApi.projects.changes('project-id'),
      ),
    );
  });
  test('encodes repository and special file names in a comparison request', async () => {
    const originalFetch = globalThis.fetch;
    let url = '';
    globalThis.fetch = async (input) => {
      url = String(input);
      return Response.json({ status: 'pending' }, { status: 202 });
    };
    try {
      await workspaceApi.projects.fileDiff(
        'project-id',
        'my repo',
        'a?b\nc.ts',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/projects/project-id/files/diff');
    assert.equal(parsed.searchParams.get('repository'), 'my repo');
    assert.equal(parsed.searchParams.get('path'), 'a?b\nc.ts');
  });
  test('reads a directory, a file and a diff through the new routes', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) {
        return Response.json({
          path: 'src',
          entries: [
            { name: 'a.ts', path: 'src/a.ts', type: 'file', size: 12 },
            { name: 'sub', path: 'src/sub', type: 'directory' },
          ],
        });
      }
      if (requests.length === 2) {
        return Response.json({
          path: 'src/a.ts',
          content: 'export {}',
          truncated: false,
          binary: false,
        });
      }
      return Response.json({
        repositories: [
          {
            path: 'repo',
            diff: '@@ -1 +1 @@',
            changes: [{ path: 'src/a.ts', status: 'modified' }],
          },
        ],
      });
    };

    try {
      assert.deepEqual(await workspaceApi.projects.files('project-id', 'src'), {
        status: 'ready',
        path: 'src',
        entries: [
          { name: 'a.ts', path: 'src/a.ts', type: 'file', size: 12 },
          { name: 'sub', path: 'src/sub', type: 'directory' },
        ],
      });
      assert.deepEqual(
        await workspaceApi.projects.file('project-id', 'src/a.ts'),
        {
          status: 'ready',
          file: {
            path: 'src/a.ts',
            content: 'export {}',
            truncated: false,
            binary: false,
          },
        },
      );
      assert.deepEqual(await workspaceApi.projects.diff('project-id'), {
        status: 'ready',
        diff: {
          repositories: [
            {
              path: 'repo',
              diff: '@@ -1 +1 @@',
              changes: [{ path: 'src/a.ts', status: 'modified' }],
            },
          ],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(
      requests[0]?.url,
      'http://127.0.0.1:3000/projects/project-id/files?path=src',
    );
    assert.equal(
      requests[1]?.url,
      'http://127.0.0.1:3000/projects/project-id/files/content?path=src%2Fa.ts',
    );
    assert.equal(
      requests[2]?.url,
      'http://127.0.0.1:3000/projects/project-id/diff',
    );
  });

  test('omits the query entirely when the path names the workspace root', async () => {
    const originalFetch = globalThis.fetch;
    let url = '';
    globalThis.fetch = async (input) => {
      url = String(input);
      return Response.json({ path: '', entries: [] });
    };
    try {
      assert.deepEqual(await workspaceApi.projects.files('project-id'), {
        status: 'ready',
        path: '',
        entries: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(url, 'http://127.0.0.1:3000/projects/project-id/files');
  });

  test('reports a pending lease with the Retry-After delay', async () => {
    const result = await withAnswer(
      Response.json(
        { status: 'pending' },
        { status: 202, headers: { 'Retry-After': '2' } },
      ),
      () => workspaceApi.projects.files('project-id'),
    );

    assert.deepEqual(result, { status: 'pending', retryAfterSeconds: 2 });
  });

  test('defaults the retry delay to one second when the header is absent', async () => {
    const result = await withAnswer(
      Response.json({ status: 'pending' }, { status: 202 }),
      () => workspaceApi.projects.files('project-id'),
    );

    assert.deepEqual(result, { status: 'pending', retryAfterSeconds: 1 });
  });

  test('reports an expired lease', async () => {
    const result = await withAnswer(
      Response.json(
        { error: { code: 'project_path_expired', message: 'Expired.' } },
        { status: 410 },
      ),
      () => workspaceApi.projects.diff('project-id'),
    );

    assert.deepEqual(result, { status: 'expired' });
  });

  test('reports an unavailable sandbox', async () => {
    const result = await withAnswer(
      Response.json(
        { error: { code: 'project_files_unavailable', message: 'Nope.' } },
        { status: 409 },
      ),
      () => workspaceApi.projects.file('project-id', 'src/a.ts'),
    );

    assert.deepEqual(result, { status: 'unavailable' });
  });

  test('reports an unknown Project as missing', async () => {
    const result = await withAnswer(
      Response.json(
        { error: { code: 'project_not_found', message: 'Missing.' } },
        { status: 404 },
      ),
      () => workspaceApi.projects.files('project-id'),
    );

    assert.deepEqual(result, { status: 'missing' });
  });

  test('reports an unknown workspace path as not found', async () => {
    const result = await withAnswer(
      Response.json(
        { error: { code: 'project_path_not_found', message: 'Missing.' } },
        { status: 404 },
      ),
      () => workspaceApi.projects.file('project-id', 'src/nope.ts'),
    );

    assert.deepEqual(result, { status: 'not_found' });
  });

  test('reports an invalid workspace path', async () => {
    const result = await withAnswer(
      Response.json(
        { error: { code: 'invalid_project_path', message: 'Invalid.' } },
        { status: 422 },
      ),
      () => workspaceApi.projects.files('project-id', 'src/../etc'),
    );

    assert.deepEqual(result, { status: 'invalid_path' });
  });

  test('rejects a malformed ready answer', async () => {
    await assert.rejects(
      withAnswer(Response.json({ path: 'src', entries: 'not-an-array' }), () =>
        workspaceApi.projects.files('project-id'),
      ),
      (error) =>
        error instanceof WorkspaceError &&
        error.message === 'Doric returned an invalid response.',
    );
  });
});
