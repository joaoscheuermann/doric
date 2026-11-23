import {
  type Call,
  type CallArg,
  ContractError,
  defineMethod,
  defineService,
  type Log,
} from 'bundle/contracts';

import {
  type BackgroundTerminal,
  terminalServiceMethods as methods,
  type TerminalResult,
  type TerminalService,
  TerminalServiceV1,
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
 * terminal/v1's operations over the registry (D1), shared by the kernel's
 * `defineService` and the process's `TerminalService`. Semantics as today
 * (`terminal.proto`, the kernel's `TerminalService` doc), with:
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

/**
 * terminal/v1 1.2.0: the kernel's `defineService(TerminalServiceV1, …)` over
 * `createTerminalOperations`. `run` is the runner's prompt terminal control:
 * it runs on the calling prompt's own Thread (call.scope) while neither the
 * Thread nor its Project is closing, and delivers a background command's
 * result to that Thread as a terminal-sourced prompt. `create` is the manual
 * shell of `WorkspaceService.terminals.create`; the rest reads the registry.
 * Kernel-only.
 */
export const terminalService = (operations: TerminalService) =>
  defineService(TerminalServiceV1, {
    run: defineMethod({
      ...methods.run,
      execute: (input, call) => operations.run(input, call),
    }),
    list: defineMethod({
      expose: 'desktop',
      ...methods.list,
      execute: (projectId, call) => operations.list(projectId, call),
    }),
    create: defineMethod({
      expose: 'desktop',
      ...methods.create,
      execute: ([threadId, size], call) =>
        operations.create(threadId, size, call),
    }),
    snapshot: defineMethod({
      expose: 'desktop',
      ...methods.snapshot,
      execute: ([terminalId, after], call) =>
        operations.snapshot(terminalId, after, call),
    }),
    input: defineMethod({
      expose: 'desktop',
      ...methods.input,
      execute: ([terminalId, data], call) =>
        operations.input(terminalId, data, call),
    }),
    resize: defineMethod({
      expose: 'desktop',
      ...methods.resize,
      execute: ([terminalId, cols, rows], call) =>
        operations.resize(terminalId, cols, rows, call),
    }),
    stop: defineMethod({
      expose: 'desktop',
      ...methods.stop,
      execute: (terminalId, call) => operations.stop(terminalId, call),
    }),
    rename: defineMethod({
      expose: 'desktop',
      ...methods.rename,
      execute: ([terminalId, name], call) =>
        operations.rename(terminalId, name, call),
    }),
    watchProject: defineMethod({
      expose: 'desktop',
      ...methods.watchProject,
      execute: ([projectId, listener], call) =>
        operations.watchProject(projectId, listener, call),
    }),
  });
