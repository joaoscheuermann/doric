// The committed transcript of AC5.4 (bundle isolation 5(b), section 7 of the
// step plan): one Thread, 100 prompts of the reader, 500 settled tool calls in
// `tool.started`/`tool.finished` rows and 20 framed background terminal
// results. Built by code so it stays the same transcript on every run:
//
// - The 500 calls, in proportion to how often agents call them (OD-1): 150
//   `terminal` (20 of them background, with a `terminal_id`), 100 `edit`, 50
//   `write`, 25 `view-image`, 25 `thread-spawn`, 50 `load_skill` and 100
//   others (`grep`, `find`).
// - Each prompt holds five calls. Prompts alternate five single-call bursts
//   (a thought before each call) and one five-call burst (one thought, then
//   five calls), so grouped and standalone drawings are both drawn.
// - After every fifth prompt, the host's framed answer of a background
//   terminal arrives as a prompt of the source `terminal`.
// - Everything is settled: no stream stays live.
//
// `serveTranscript` answers the Thread `TRANSCRIPT_THREAD` with this log, and
// `terminal/v1` (over Connect through `terminalRoutes(host)`) with no
// terminals.

import type { ConnectRouter, ServiceImpl } from '@connectrpc/connect';
import { terminalOneofs } from 'terminal/contracts';
import {
  ListResponseSchema,
  TerminalService,
  WatchProjectResponseSchema,
} from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';

import type { FakeHost } from './harness';
import { serveSettingsConnect } from './settings-host';
import { serveWorkspaceConnect } from './workspace-connect';
import {
  filesRoutes,
  gitRoutes,
  proto,
  type ThreadEventRow,
} from './workspace-content';
import {
  resourcesRoutes,
  THREADS,
  usageRoutes,
  type WorkspaceThread,
} from './workspace-host';

/** The Thread whose transcript is measured: "Accessibility audit" of Checkout redesign. */
export const TRANSCRIPT_THREAD: WorkspaceThread = (() => {
  const found = THREADS.find((item) => item.name === 'Accessibility audit');
  if (found === undefined)
    throw new Error('The workspace has no Thread to measure.');
  return found;
})();

/** The last answer of the transcript: drawn, the transcript's last row is there. */
export const TRANSCRIPT_END = 'The transcript-cost fixture ends here.';

/** The user's prompt of audit step `step` (from 1). */
const auditPrompt = (step: number): string =>
  `Audit step ${step}: check the next five modules.`;

/**
 * The first prompt of the transcript, its oldest row. The chat fills a long
 * transcript newest-first, so this row drawn means every row is there.
 */
export const TRANSCRIPT_START = auditPrompt(1);

export const USER_PROMPTS = 100;
export const CALLS_PER_PROMPT = 5;
export const TERMINAL_RESULTS = 20;

/** The elements the registrants draw calls and inputs with (5(b)). */
export const DRAWING_TAGS: readonly string[] = [
  'files-edit-call',
  'default-skill-call',
  'threads-spawn-call',
  'terminal-tool-call',
  'terminal-result',
];

/**
 * The tool of each call in ten, the tenth alternating `view-image` (even
 * tens) and `thread-spawn` (odd tens): over 50 tens, 150 `terminal`, 100
 * `edit`, 50 `write`, 50 `load_skill`, 50 `grep`, 50 `find`, 25 `view-image`
 * and 25 `thread-spawn`.
 */
const TEN = [
  'terminal',
  'edit',
  'grep',
  'terminal',
  'write',
  'load_skill',
  'edit',
  'find',
  'terminal',
] as const;

const toolOf = (call: number): string => {
  const ten = Math.floor(call / 10);
  const place = call % 10;
  return place < TEN.length
    ? (TEN[place] as string)
    : ten % 2 === 0
      ? 'view-image'
      : 'thread-spawn';
};

const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

const pad = (value: number, width: number): string =>
  String(value).padStart(width, '0');

const promptIdOf = (index: number): string =>
  `${TRANSCRIPT_THREAD.id.slice(0, 8)}-0000-4000-8000-${pad(index + 1, 12)}`;

const terminalIdOf = (index: number): string => `term-${pad(index + 1, 4)}`;

/** A settled foreground command's output, as the terminal tool returns it. */
const terminalOutput = (command: string): string =>
  JSON.stringify({
    schema: 'terminal.compact.v1',
    trace_id: null,
    command,
    working_directory: '/workspace',
    exit_code: 0,
    duration_ms: 1200,
    termination_reason: 'exited',
    success: true,
    stdout: {
      bytes: 12,
      lines: 1,
      head: ['1 passing'],
      tail: [],
      omitted_lines: 0,
      omitted_bytes: 0,
      truncated: false,
    },
    stderr: {
      bytes: 0,
      lines: 0,
      head: [],
      tail: [],
      omitted_lines: 0,
      omitted_bytes: 0,
      truncated: false,
    },
    diagnostics: [],
    truncation: { truncated: false, message: 'ok' },
    raw_output_ref: null,
  });

const SKILLS = ['cwd/review', 'mcp/github/issues', 'commit'] as const;

/** The call's payload and settled output, by its tool. */
const callOf = (
  call: number,
  background: () => string | undefined,
): { name: string; payload: unknown; output: string } => {
  const name = toolOf(call);
  const file = `apps/web/src/module-${pad(call, 3)}.ts`;
  switch (name) {
    case 'terminal': {
      const terminalId = background();
      const command = `npm test -- --run src/module-${pad(call, 3)}`;
      return terminalId === undefined
        ? {
            name,
            payload: { command, working_directory: '/workspace' },
            output: terminalOutput(command),
          }
        : {
            name,
            payload: {
              command,
              working_directory: '/workspace',
              background: true,
            },
            output: JSON.stringify({
              background: true,
              terminal_id: terminalId,
            }),
          };
    }
    case 'edit':
      return {
        name,
        payload: {
          path: file,
          edits: [{ oldText: 'const old = 1;', newText: 'const next = 2;' }],
        },
        output: JSON.stringify({
          success: true,
          diff: ' 1 -const old = 1;\n 1 +const next = 2;',
          first_changed_line: 1,
        }),
      };
    case 'write':
      return {
        name,
        payload: { path: file, content: 'export const x = 1;\n' },
        output: JSON.stringify({
          success: true,
          bytes_written: 20,
          diff: `Edited ${file} (+1 -0)\n1 +export const x = 1;`,
        }),
      };
    case 'view-image':
      return {
        name,
        payload: { path: `docs/screens/screen-${pad(call, 3)}.png` },
        output: `Attached docs/screens/screen-${pad(call, 3)}.png`,
      };
    case 'thread-spawn':
      return {
        name,
        payload: {
          prompt: `Check module ${pad(call, 3)} for contrast issues.`,
          title: `Audit module ${pad(call, 3)}`,
        },
        output: JSON.stringify({
          threadId: `cccccccc-0000-4000-8000-${pad(call, 12)}`,
          promptId: `dddddddd-0000-4000-8000-${pad(call, 12)}`,
        }),
      };
    case 'load_skill':
      return {
        name,
        payload: { name: SKILLS[call % SKILLS.length] },
        output: 'Loaded.',
      };
    default:
      return {
        name,
        payload: { pattern: 'aria-label', path: file },
        output: `${file}:9:      <Button aria-label="Pay">`,
      };
  }
};

/** The host's framed answer of a background command, as it enqueues it. */
const terminalResultText = (terminalId: string, index: number): string =>
  [
    '# Background terminal result',
    '',
    `Terminal: ${terminalId}`,
    `Originating prompt: ${promptIdOf(index)}`,
    `Command: npm run lint -- --dir src/module-${pad(index, 3)}`,
    `Exit code: ${index % 4 === 0 ? 1 : 0}`,
    'Reason: exited',
    'Duration: 1940 ms',
    '',
    '## Standard output (last 12000 characters)',
    '',
    'Checked 12 files.',
    '',
    '## Standard error (last 12000 characters)',
    '',
    index % 4 === 0 ? 'Found 1 error.' : '',
  ].join('\n');

/** The whole log of `TRANSCRIPT_THREAD`, in sequence order. */
export const transcriptLog = (): readonly ThreadEventRow[] => {
  const rows: ThreadEventRow[] = [];
  let sequence = 0;
  let call = 0;
  let terminals = 0;
  let backgrounds = 0;
  let prompts = 0;
  const started: string[] = [];

  const push = (promptId: string, event: Record<string, unknown>): void => {
    sequence += 1;
    rows.push({
      projectId: TRANSCRIPT_THREAD.projectId,
      threadId: TRANSCRIPT_THREAD.id,
      promptId,
      sequence,
      type: event.type as string,
      event,
      createdAt: new Date(EPOCH + sequence * 1000).toISOString(),
    });
  };

  /** 20 of the 150 terminal calls run in the background. */
  const background = (): string | undefined => {
    const ordinal = terminals;
    terminals += 1;
    if (ordinal % 15 >= 2 || backgrounds >= TERMINAL_RESULTS) return undefined;
    const id = terminalIdOf(backgrounds);
    backgrounds += 1;
    started.push(id);
    return id;
  };

  const toolCall = (promptId: string): void => {
    const { name, payload, output } = callOf(call, background);
    const id = `call-${pad(call, 3)}`;
    call += 1;
    push(promptId, { type: 'tool.started', call: { id, name, payload } });
    push(promptId, {
      type: 'tool.finished',
      call: { id, name, payload },
      record: { output },
    });
  };

  const answer = (
    promptId: string,
    text: string,
    source: Record<string, unknown>,
  ): void => {
    push(promptId, { type: 'text.delta', delta: text });
    push(promptId, {
      type: 'prompt.finished',
      status: 'completed',
      text,
      source,
    });
  };

  for (let index = 0; index < USER_PROMPTS; index += 1) {
    const promptId = promptIdOf(prompts);
    prompts += 1;
    const source = { kind: 'user' };
    push(promptId, {
      type: 'prompt.accepted',
      text: auditPrompt(index + 1),
      source,
      queued: false,
    });
    push(promptId, { type: 'prompt.started' });
    if (index % 2 === 0) {
      for (let burst = 0; burst < CALLS_PER_PROMPT; burst += 1) {
        push(promptId, {
          type: 'reasoning.delta',
          delta: `Looking at module ${call + 1}.`,
        });
        toolCall(promptId);
      }
    } else {
      push(promptId, {
        type: 'reasoning.delta',
        delta: `Checking modules ${call + 1} to ${call + CALLS_PER_PROMPT}.`,
      });
      for (let burst = 0; burst < CALLS_PER_PROMPT; burst += 1)
        toolCall(promptId);
    }
    answer(promptId, `Step ${index + 1} is done.`, source);

    // A background command settles: the host enqueues its framed answer.
    if (index % 5 === 4) {
      const terminalId = started[Math.floor(index / 5)];
      if (terminalId === undefined) continue;
      const resultId = promptIdOf(prompts);
      prompts += 1;
      const terminalSource = { kind: 'terminal', terminalId };
      push(resultId, {
        type: 'prompt.accepted',
        text: terminalResultText(terminalId, index),
        source: terminalSource,
        queued: true,
      });
      push(resultId, { type: 'prompt.started' });
      answer(
        resultId,
        index === USER_PROMPTS - 1
          ? TRANSCRIPT_END
          : `Noted the result of ${terminalId}.`,
        terminalSource,
      );
    }
  }

  return rows;
};

/** The `TerminalService` handlers of each host, as `serveTerminal` added them. */
const terminalHandlers = new WeakMap<
  FakeHost,
  Partial<ServiceImpl<typeof TerminalService>>
>();

/** Adds `handlers` to the `TerminalService` of `host`. */
export const serveTerminal = (
  host: FakeHost,
  handlers: Partial<ServiceImpl<typeof TerminalService>>,
): void => {
  terminalHandlers.set(host, {
    ...terminalHandlers.get(host),
    ...handlers,
  });
};

/**
 * Registers the `TerminalService` handlers `serveTerminal` added for `host`
 * on `router` (none: nothing is registered).
 */
export const terminalRoutes =
  (host: FakeHost) =>
  (router: ConnectRouter): void => {
    const handlers = terminalHandlers.get(host);
    if (handlers !== undefined) router.service(TerminalService, handlers);
  };

/**
 * Answers the measured Thread with `transcriptLog()` (after `serveWorkspace`,
 * whose answers for the other Threads it keeps) over Connect
 * (`forwardConnect`), and `terminal/v1` with no terminals: the transcript is
 * settled, so no live output is watched.
 */
export const serveTranscript = (host: FakeHost): void => {
  const log = transcriptLog();
  const record = { ...TRANSCRIPT_THREAD, lastSequence: log.length };
  // The same Thread and log over Connect, which the chat and the runtime's
  // records read (S65a); the workspace's other Threads and the contracts it
  // answers over Connect as `serveWorkspace`.
  serveTerminal(host, {
    list: () => proto(ListResponseSchema, { terminals: [] }),
    watchProject: async function* (request, context) {
      yield proto(
        WatchProjectResponseSchema,
        { kind: 'snapshot', projectId: request.projectId, terminals: [] },
        terminalOneofs,
      );

      // The stream stays open, as the window's terminal feed watches the
      // Project until it cancels.
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
    },
  });
  host.forwardConnect(
    serveWorkspaceConnect({
      threads: [record],
      logs: new Map([[record.id, log]]),
      routes: (router) => {
        serveSettingsConnect(router);
        gitRoutes(host)(router);
        filesRoutes(host)(router);
        usageRoutes(host)(router);
        resourcesRoutes(host)(router);
        terminalRoutes(host)(router);
      },
    }).forward,
  );
};
