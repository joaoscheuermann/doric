import type { LexicalNode } from 'lexical';

import { $isTerminalResultNode } from '../../../../../src/client/components/organisms/conversation/nodes/terminal-result-node.js';
import { promptIdOf, turnsOfType } from '../../../../support/conversation.js';
import { $focusNodes, TurnsEditor } from '../../../../support/editor.js';
import {
  backgroundResult,
  failingTests,
  passingTests,
} from '../../../../support/fixtures.js';

/** The prompt the host writes the answer under. */
const prompt = promptIdOf(3101);

/** The prompt that started the command, as the header names it. */
const origin = promptIdOf(3099);

const terminalId = 'terminal-3f8a';

const devCommand = 'npm run dev -- --port 5173';

/**
 * The answer a settled background command writes into its Thread: a prompt of
 * its own, sourced by the terminal that produced it.
 */
const answer = (input: {
  readonly command: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly reason?: 'exited' | 'timeout' | 'terminated' | 'failed';
  readonly durationMs?: number;
}) =>
  turnsOfType('user', (log) =>
    log.push(prompt, {
      type: 'prompt.accepted',
      text: backgroundResult({
        terminalId,
        promptId: origin,
        ...input,
      }),
      source: { kind: 'terminal', terminalId },
    }),
  );

/** A test run that passed, as the agent left it in the background. */
const passed = answer({
  command: 'npm test -- --run src/checkout',
  stdout: passingTests.join('\n'),
  durationMs: 1_940,
});

/** A test run that failed: folded, it still says so in its header. */
const failed = answer({
  command: 'npm test -- --run src/checkout',
  stdout: passingTests.slice(0, 5).join('\n'),
  stderr: failingTests.join('\n'),
  exitCode: 1,
  durationMs: 2_340,
});

/** A server the host stopped once its window ran out. */
const timedOut = answer({
  command: devCommand,
  stderr: 'Timed out after 30000 ms',
  exitCode: -1,
  reason: 'timeout',
  durationMs: 30_000,
});

/** A command that said nothing at all. */
const silent = answer({ command: 'git fetch origin', durationMs: 620 });

/** A long command, so the header's preview truncates and the card wraps. */
const longCommand = answer({
  command:
    'npx playwright test e2e/checkout.spec.ts --project=chromium --reporter=line --retries=2 --workers=4 --grep "@payments"',
  stdout: ['Running 6 tests using 4 workers', '  6 passed (14.2s)'].join('\n'),
  durationMs: 14_200,
});

const open = (blocks: readonly LexicalNode[]): void => {
  for (const block of blocks)
    if ($isTerminalResultNode(block)) block.setChosen(true);
};

export default {
  title: 'Chat/Nodes/Terminal result',
};

/** A command that finished cleanly: folded behind the command it answered. */
export const Result = {
  render: () => <TurnsEditor turns={passed} />,
};

/** The same result opened: the command, how it exited and its output. */
export const Open = {
  render: () => <TurnsEditor turns={passed} after={open} />,
};

/** A failure: open on its own, because a reader must not scroll past it. */
export const Failed = {
  render: () => <TurnsEditor turns={failed} />,
};

/** A command the host stopped at its window's end. */
export const TimedOut = {
  render: () => <TurnsEditor turns={timedOut} />,
};

/** A command that reported nothing in either stream. */
export const NoOutput = {
  render: () => <TurnsEditor turns={silent} after={open} />,
};

/** A command longer than the header's preview holds. */
export const LongCommand = {
  render: () => <TurnsEditor turns={longCommand} after={open} />,
};

/** The block holding the editor's focus. */
export const Focused = {
  render: () => (
    <TurnsEditor
      turns={passed}
      after={(blocks) => $focusNodes(...blocks.filter($isTerminalResultNode))}
    />
  ),
};
