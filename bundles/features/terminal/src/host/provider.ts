import { defineMethod, defineService, type Log } from 'bundle/contracts';

import {
  type BackgroundTerminal,
  terminalServiceMethods as methods,
  type TerminalResult,
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

const inactive = () => new Error('Thread is inactive.');

/** The background result prompt, as the runner wrote it (`runner.ts`). */
export const backgroundResultText = (
  promptId: string,
  command: string,
  result: TerminalResult,
): string =>
  `# Background terminal result\n\nTerminal: ${result.terminalId}\nOriginating prompt: ${promptId}\nCommand: ${command}\nExit code: ${result.exitCode}\nReason: ${result.reason}\nDuration: ${result.durationMs} ms\n\n## Standard output (last 12000 characters)\n\n${result.stdout.slice(-12000)}\n\n## Standard error (last 12000 characters)\n\n${result.stderr.slice(-12000)}`;

/**
 * terminal/v1 1.1.0. `run` is the runner's prompt terminal control: it runs
 * on the calling prompt's own Thread (call.scope) while neither the Thread
 * nor its Project is closing, and delivers a background command's result to
 * that Thread as a terminal-sourced prompt. `create` is the manual shell of
 * `WorkspaceService.terminals.create`; the rest reads the registry.
 */
export const terminalService = ({
  registry,
  notices,
  redactions,
  workspace,
  threads,
  log,
}: ProviderOptions) =>
  defineService(TerminalServiceV1, {
    run: defineMethod({
      ...methods.run,
      execute: async (input, call) => {
        call.signal.throwIfAborted();
        const threadId = call.scope?.threadId;
        const promptId = call.scope?.promptId;
        if (threadId === undefined || promptId === undefined) throw inactive();
        const outcome = await workspace().withThread(
          threadId,
          { exclusive: false },
          async (thread) => {
            if (thread.closing()) throw inactive();
            // The terminal stream redacts with the list read here.
            await redactions.refresh();
            return registry.start({
              sandbox: thread.sandbox,
              projectId: thread.projectId,
              threadId,
              origin: 'agent',
              input,
              ...(input.background ? {} : { signal: call.signal }),
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
    }),
    list: defineMethod({
      expose: 'desktop',
      ...methods.list,
      execute: async (projectId) => [...registry.list(projectId)],
    }),
    create: defineMethod({
      expose: 'desktop',
      ...methods.create,
      execute: async ([threadId, { cols, rows }], call) => {
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
    }),
    snapshot: defineMethod({
      expose: 'desktop',
      ...methods.snapshot,
      execute: async ([terminalId, after]) =>
        registry.snapshot(terminalId, after),
    }),
    input: defineMethod({
      expose: 'desktop',
      ...methods.input,
      execute: ([terminalId, data]) => registry.input(terminalId, data),
    }),
    resize: defineMethod({
      expose: 'desktop',
      ...methods.resize,
      execute: ([terminalId, cols, rows]) =>
        registry.resize(terminalId, cols, rows),
    }),
    stop: defineMethod({
      expose: 'desktop',
      ...methods.stop,
      execute: (terminalId) => registry.stop(terminalId),
    }),
    watchProject: defineMethod({
      expose: 'desktop',
      ...methods.watchProject,
      execute: ([projectId, listener]) =>
        watchProject(notices, registry, projectId, listener),
    }),
  });
