import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import type { Host } from 'host';
import type { Sandbox, SandboxExecInput } from 'sandbox';

import type { TerminalOutput } from '../src/host/tools/terminal.js';
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
  void test('registers the workspace tools in their model-visible order, always available', async () => {
    const tools = await activatedTools(sandbox([]), fakeHost());

    assert.deepEqual(
      tools.map(({ tool, alwaysAvailable }) => [tool.name, alwaysAvailable]),
      [
        ['cwd', true],
        ['edit', true],
        ['find', true],
        ['grep', true],
        ['terminal', true],
        ['tree', true],
        ['web', true],
        ['write', true],
      ],
    );
  });

  void test('runs terminal commands through terminal/v1 when a provider serves the prompt', async () => {
    const execs: SandboxExecInput[] = [];
    const host: Host = {
      ...fakeHost(),
      terminals: {
        run: async () => ({ terminalId: 'terminal-7', background: true }),
      },
    };
    const terminal = (await activatedTools(sandbox(execs), host)).find(
      ({ tool }) => tool.name === 'terminal',
    )?.tool;

    assert.deepEqual(
      await terminal?.execute({ command: 'npm run dev', background: true }),
      { terminal_id: 'terminal-7', background: true },
    );
    assert.deepEqual(execs, []);
  });

  void test('falls back to a plain sandbox command when terminal/v1 cannot serve the prompt', async () => {
    const execs: SandboxExecInput[] = [];
    const host: Host = {
      ...fakeHost(),
      terminals: {
        run: async () => {
          throw new ContractError('unavailable', 'No live terminals.');
        },
      },
    };
    const terminal = (await activatedTools(sandbox(execs), host)).find(
      ({ tool }) => tool.name === 'terminal',
    )?.tool;
    const result = (await terminal?.execute({ command: 'echo plain' })) as
      | TerminalOutput
      | undefined;

    assert.equal(result?.schema, 'terminal.compact.v1');
    assert.deepEqual(result?.stdout.head, ['plain']);
    assert.deepEqual(
      execs.map(({ cmd }) => cmd),
      [['sh', '-lc', 'echo plain']],
    );
    await assert.rejects(
      terminal?.execute({ command: 'npm run dev', background: true }) ??
        Promise.resolve(),
      /This host does not support live terminals\./u,
    );
  });

  void test('refuses background and PTY commands without any terminal provider', async () => {
    const terminal = (await activatedTools(sandbox([]), fakeHost())).find(
      ({ tool }) => tool.name === 'terminal',
    )?.tool;

    await assert.rejects(
      terminal?.execute({ command: 'vim', pty: true }) ?? Promise.resolve(),
      /This host does not support live terminals\./u,
    );
  });
});
