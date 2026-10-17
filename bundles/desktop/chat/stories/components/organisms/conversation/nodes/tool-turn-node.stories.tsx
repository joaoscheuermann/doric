import type { LexicalNode } from 'lexical';

import { $isToolTurnNode } from '../../../../../src/client/components/organisms/conversation/nodes/tool-turn-node.js';
import {
  editArgs,
  editResult,
  failingTests,
  nodesThread,
  passingTests,
  projectId,
  promptIdOf,
  type StoryLog,
  terminalArgs,
  terminalResult,
  testCommand,
  turnsOfType,
  writeArgs,
} from '../../../../support/conversation.js';
import { TurnsEditor } from '../../../../support/editor.js';

const prompt = promptIdOf(2301);

/** The tool calls of a run still going, each drawn as its own block. */
const calls = (build: (log: StoryLog) => void) =>
  turnsOfType('tool_call', (log) => {
    log.prompt(prompt, 'Fix the Pay button in dark mode.');
    log.push(prompt, { type: 'agent.started' });
    build(log);
  });

const openAll = (blocks: readonly LexicalNode[]) => {
  for (const block of blocks) if ($isToolTurnNode(block)) block.setChosen(true);
};

export default {
  title: 'Chat/Nodes/Tool turn',
};

/** A call the agent is still running. */
export const Running = {
  render: () => (
    <TurnsEditor
      turns={calls((log) =>
        log.tool(prompt, 'call-1', 'grep', {
          pattern: 'bg-white',
          path: 'src',
        }),
      )}
    />
  ),
};

/** A finished call: folded, named by the tool it ran. */
export const Finished = {
  render: () => (
    <TurnsEditor
      turns={calls((log) =>
        log.tool(
          prompt,
          'call-1',
          'grep',
          { pattern: 'bg-white', path: 'src' },
          {
            output:
              'src/components/Checkout.tsx:41\nsrc/components/CartSummary.tsx:18',
          },
        ),
      )}
    />
  ),
};

/** A finished call the reader opened: its arguments and result. */
export const FinishedOpen = {
  render: () => (
    <TurnsEditor
      after={openAll}
      turns={calls((log) =>
        log.tool(
          prompt,
          'call-1',
          'grep',
          { pattern: 'bg-white', path: 'src' },
          {
            output:
              'src/components/Checkout.tsx:41\nsrc/components/CartSummary.tsx:18',
          },
        ),
      )}
    />
  ),
};

/** A call that failed, opened on its error. */
export const Failed = {
  render: () => (
    <TurnsEditor
      after={openAll}
      turns={calls((log) =>
        log.tool(
          prompt,
          'call-1',
          'read',
          { path: 'src/components/Payment.tsx' },
          { error: 'ENOENT: no such file or directory' },
        ),
      )}
    />
  ),
};

/** A terminal command that passed. */
export const TerminalPassed = {
  render: () => (
    <TurnsEditor
      turns={calls((log) =>
        log.tool(
          prompt,
          'call-1',
          'terminal',
          JSON.parse(terminalArgs(testCommand)),
          {
            output: terminalResult({
              command: testCommand,
              stdout: passingTests,
            }),
          },
        ),
      )}
    />
  ),
};

/** A terminal command that failed, opened on its output. */
export const TerminalFailed = {
  render: () => (
    <TurnsEditor
      after={openAll}
      turns={calls((log) =>
        log.tool(
          prompt,
          'call-1',
          'terminal',
          JSON.parse(terminalArgs('npm test')),
          {
            output: terminalResult({
              command: 'npm test',
              stdout: passingTests.slice(0, 3),
              stderr: failingTests,
              exitCode: 1,
              durationMs: 8_420,
            }),
          },
        ),
      )}
    />
  ),
};

const liveCommand = 'npm run dev -- --port 5173';

/** A terminal still running, streaming the live session's output. */
export const TerminalLive = {
  render: () => (
    <TurnsEditor
      host={{
        terminals: [
          {
            terminal: {
              id: 'terminal-dev',
              projectId,
              threadId: nodesThread.id,
              origin: 'agent',
              command: liveCommand,
              cwd: '/workspace/storefront',
              startedAt: '2026-10-16T08:58:10.000Z',
              timeoutMs: null,
              state: 'running',
              pty: false,
            },
            output: [
              '> storefront@2.4.0 dev',
              '> vite --port 5173',
              '',
              '  VITE v5.4.8  ready in 412 ms',
              '',
              '  ➜  Local:   http://localhost:5173/',
              '  ➜  press h + enter to show help',
              '',
            ].join('\n'),
          },
        ],
      }}
      turns={calls((log) =>
        log.tool(
          prompt,
          'call-1',
          'terminal',
          JSON.parse(terminalArgs(liveCommand)),
        ),
      )}
    />
  ),
};

/** An edit: open by default on its diff. */
export const Edit = {
  render: () => (
    <TurnsEditor
      turns={calls((log) =>
        log.tool(prompt, 'call-1', 'edit', JSON.parse(editArgs), {
          output: editResult,
        }),
      )}
    />
  ),
};

/** A write still running: the preview of the file it creates. */
export const WriteRunning = {
  render: () => (
    <TurnsEditor
      turns={calls((log) =>
        log.tool(prompt, 'call-1', 'write', JSON.parse(writeArgs)),
      )}
    />
  ),
};

/** Many calls of a run still going, one block each. */
export const ManyCalls = {
  render: () => (
    <TurnsEditor
      turns={calls((log) => {
        const files = [
          'Checkout.tsx',
          'CartSummary.tsx',
          'PaymentForm.tsx',
          'SavedCards.tsx',
          'OrderTotal.tsx',
          'CouponField.tsx',
          'ShippingPicker.tsx',
        ];
        files.forEach((file, index) => {
          log.tool(
            prompt,
            `call-${index + 1}`,
            'read',
            { path: `src/components/${file}` },
            { output: `export function ${file.replace('.tsx', '')}() { … }` },
          );
        });
        log.tool(prompt, 'call-8', 'grep', {
          pattern: 'bg-white',
          path: 'src',
        });
      })}
    />
  ),
};
