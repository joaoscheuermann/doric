import {
  type Call,
  type CallArg,
  ContractError,
  type Log,
} from 'bundle/contracts';

import type {
  BackgroundTerminal,
  TerminalResult,
  TerminalService,
} from '../contracts/index.js';
import type { RuntimeThreads, RuntimeWorkspace } from './peers.js';
import type { Redactions } from './redactions.js';
import type { TerminalRegistry } from './registry.js';
import { type TerminalNotices, watchProject } from './watch.js';

export interface ProviderOptions {
  readonly registry: TerminalRegistry;
  readonly notices: TerminalNotices;
  readonly redactions: Pick<Redactions, 'refresh'>;
  readonly workspace: () => RuntimeWorkspace;
  readonly threads: () => RuntimeThreads;
  readonly log: () => Log;
}

const inactive = () => new ContractError('internal', 'Thread is inactive.');

/** The scope of `call` when it is a `Call`; none for bare call options. */
const scopeOf = (call: CallArg | undefined): Call['scope'] =>
  call !== undefined && 'scope' in call ? call.scope : undefined;

/** The background result prompt, as the runner wrote it (`runner.ts`). */
export const backgroundResultText = (
  promptId: string,
  command: string,
  result: TerminalResult,
): string =>
  `# Background terminal result\n\nTerminal: ${result.terminalId}\nOriginating prompt: ${promptId}\nCommand: ${command}\nExit code: ${result.exitCode}\nReason: ${result.reason}\nDuration: ${result.durationMs} ms\n\n## Standard output (last 12000 characters)\n\n${result.stdout.slice(-12000)}\n\n## Standard error (last 12000 characters)\n\n${result.stderr.slice(-12000)}`;

/**
 * terminal/v1's operations over the registry (D1), served by the process's
 * `TerminalService`. Semantics as `terminal.proto` states them, with:
 * - `run`: needs `call.scope.threadId` and `promptId`. Holds the Thread with
 *   `{exclusive: false}`; `await thread.closing()` true, a refused hold, or a
 *   missing scope rejects with `ContractError('internal', 'Thread is inactive.')` and starts
 *   nothing. Background delivery as today (`backgroundResultText`), with
 *   `threads()` called outside any call (D6).
 * - `create`: `{exclusive: true, resume: true}`; a refused hold answers
 *   `undefined`. Starts `bash` (the manual shell) in `thread.cwd`, PTY.
 * - every start reads the redaction list first (`redactions.refresh()`).
 * Never throws synchronously.
 */
export const createTerminalOperations = ({
  registry,
  notices,
  redactions,
  workspace,
  threads,
  log,
}: ProviderOptions): TerminalService => ({
  run: async (input, call) => {
    call?.signal?.throwIfAborted();
    const scope = scopeOf(call);
    const threadId = scope?.threadId;
    const promptId = scope?.promptId;
    if (threadId === undefined || promptId === undefined) throw inactive();
    const outcome = await workspace().withThread(
      threadId,
      { exclusive: false },
      async (thread) => {
        if (await thread.closing()) throw inactive();
        // The terminal stream redacts with the list read here.
        await redactions.refresh();
        return registry.start({
          sandbox: thread.sandbox,
          projectId: thread.projectId,
          threadId,
          origin: 'agent',
          input,
          ...(input.background || call?.signal === undefined
            ? {}
            : { signal: call.signal }),
        });
      },
      call,
    );
    if (outcome.status !== 'ready') throw inactive();
    const started = outcome.value;
    if (!input.background) return started.result;
    const fail = () =>
      threads()
        .failTerminalResult({ threadId })
        .catch(() => {
          log().error('Terminal result delivery failed', { threadId });
        });
    void started.result.then(
      (result) =>
        threads()
          .enqueueTerminalResult({
            threadId,
            promptId,
            terminalId: result.terminalId,
            text: backgroundResultText(promptId, input.command, result),
          })
          .catch(fail),
      fail,
    );
    return {
      terminalId: started.terminal.id,
      background: true,
    } satisfies BackgroundTerminal;
  },
  list: async (projectId) => [...registry.list(projectId)],
  create: async (threadId, { cols, rows }, call) => {
    const outcome = await workspace().withThread(
      threadId,
      { exclusive: true, resume: true },
      async (thread) => {
        // The terminal stream redacts with the list read here.
        await redactions.refresh();
        const started = await registry.start({
          sandbox: thread.sandbox,
          projectId: thread.projectId,
          threadId,
          origin: 'user',
          input: {
            command: 'bash',
            cwd: thread.cwd,
            timeoutMs: 0,
            pty: true,
          },
          ...(cols === undefined ? {} : { cols }),
          ...(rows === undefined ? {} : { rows }),
        });
        return started.terminal;
      },
      call,
    );
    return outcome.status === 'ready' ? outcome.value : undefined;
  },
  snapshot: async (terminalId, after) => registry.snapshot(terminalId, after),
  input: (terminalId, data) => registry.input(terminalId, data),
  resize: (terminalId, cols, rows) => registry.resize(terminalId, cols, rows),
  stop: (terminalId) => registry.stop(terminalId),
  rename: async (terminalId, name) => registry.rename(terminalId, name),
  watchProject: (projectId, listener) =>
    watchProject(notices, registry, projectId, listener),
});
