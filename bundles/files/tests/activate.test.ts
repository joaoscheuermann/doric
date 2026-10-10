import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';

import type { Sandbox, SandboxExecInput } from 'sandbox';

import { fakeHost } from './fake-sandbox.js';
import { activatedTools } from './support/services.js';

const sandbox = (execs: SandboxExecInput[]): Sandbox =>
  ({
    id: 'sandbox-1',
    root: '/workspace',
    exec: async (input: SandboxExecInput) => {
      execs.push(input);

      return {
        exitCode: 0,
        stdout: 'plain\n',
        stderr: '',
        stdoutBytes: Buffer.from('plain\n'),
        stderrBytes: Buffer.alloc(0),
      };
    },
  }) as unknown as Sandbox;

void describe('files activation', () => {
  // `terminal` is the `terminal` bundle's (500, stage 10 host switch); the
  // catalog orders every tool by its key.
  void test('registers the workspace tools in their model-visible order, always available', async () => {
    const tools = await activatedTools(sandbox([]), fakeHost());

    assert.deepEqual(
      tools.map(({ tool, alwaysAvailable }) => [tool.name, alwaysAvailable]),
      [
        ['cwd', true],
        ['edit', true],
        ['find', true],
        ['grep', true],
        ['tree', true],
        ['web', true],
        ['write', true],
      ],
    );
  });
});
