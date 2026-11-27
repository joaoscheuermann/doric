import type { Branches, ThreadGit } from 'git/contracts';
import {
  conflictError,
  cwdRefusalMessages,
  notFoundError,
  type QueuedPrompt,
  reasoningEfforts,
  restErrors,
  type Thread,
  type ThreadEventLog,
  type ThreadQueue,
  type ThreadUsage,
} from 'runtime/contracts';
import { z } from 'zod';

import type { ApiAnswer, RouteInput } from '../answer.js';
import { nameInput, ok, refused } from '../input.js';
import type { TransportPorts } from '../ports.js';

type Op<V> = (input: RouteInput) => Promise<ApiAnswer<V>>;

/**
 * A working directory as a client may name it: absolute inside the sandbox, or
 * relative to the Thread's current directory the way `cd` reads it. What that
 * path may resolve to is the service's rule, not this input's.
 */
const cwdInput = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 &&
      value.length <= 4096 &&
      value.includes('\0') === false,
  );
/**
 * A patch changes the name, the working directory, the execution, or a
 * combination. `providerId` and `model` come together, and `effort` only with
 * them; bounds are the configuration's own.
 */
const threadInput = z
  .object({
    name: nameInput.optional(),
    cwd: cwdInput.optional(),
    providerId: z.string().trim().min(1).max(128).optional(),
    model: z.string().trim().min(1).max(512).optional(),
    effort: z.enum(reasoningEfforts).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.providerId === undefined) === (value.model === undefined) &&
      (value.effort === undefined || value.providerId !== undefined) &&
      (value.name !== undefined ||
        value.cwd !== undefined ||
        value.providerId !== undefined),
  );
const promptInput = z
  .object({
    prompt: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();
const interruptInput = z.object({ promptId: z.uuid() }).strict();
const steerInput = z
  .object({
    prompt: z.string().refine((value) => value.trim().length > 0),
    promptId: z.uuid(),
    interrupt: z.boolean().optional(),
  })
  .strict();
const editInput = z
  .object({
    text: z.string().refine((text) => text.trim().length > 0),
    revision: z.number().int().safe().nonnegative(),
  })
  .strict();
const resumeInput = z.object({ promptId: z.uuid() }).strict();
const rewindInput = z
  .object({
    promptId: z.uuid(),
    prompt: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();
const eventsInput = z.object({
  afterSequence: z.coerce.number().int().safe().nonnegative().default(0),
});
const branchInput = z
  .object({
    branch: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !value.includes('\0') && !value.startsWith('-')),
    cwd: cwdInput,
  })
  .strict();

/** The sentence each compaction refusal reads as. */
const compactRefusal: Readonly<
  Record<'disabled' | 'missing_history' | 'nothing_to_compact', string>
> = {
  disabled: 'Context compaction is disabled in the settings.',
  missing_history: 'This Thread has no conversation to compact yet.',
  nothing_to_compact:
    'Nothing condenses here: the recent conversation is already the smallest safe span.',
};

const threadMissing = refused(notFoundError('thread'));
const threadInactive = refused(conflictError('thread', 'inactive'));
const invalidPromptId = refused({
  status: 422,
  code: 'invalid_prompt',
  message: 'A promptId is required.',
});
const promptNotFound = refused({
  status: 404,
  code: 'prompt_not_found',
  message: 'The prompt was not found in this Thread.',
});

/**
 * The `/threads` route bodies over the ports (the terminal routes are
 * `terminalOperations`). Human input cannot supply a privileged origin or
 * delegation correlation. The Git and usage reads call the `git` and `usage`
 * bundles (stage 10 §4).
 */
export const threadOperations = ({
  threads,
  git,
  usage,
}: Pick<TransportPorts, 'threads' | 'git' | 'usage'>): {
  /** `GET /threads/:id`. */
  readonly get: Op<Thread>;
  /** `PATCH /threads/:id`. */
  readonly update: Op<Thread>;
  /** `GET /threads/:id/git`. */
  readonly git: Op<ThreadGit | { readonly status: 'pending' | 'unavailable' }>;
  /** `GET /threads/:id/branches`. */
  readonly branches: Op<
    Branches | { readonly status: 'pending' | 'unavailable' }
  >;
  /** `POST /threads/:id/branches`. */
  readonly switchBranch: Op<Branches>;
  /** `POST /threads/:id/prompt` → 202. */
  readonly prompt: Op<{ readonly promptId: string }>;
  /** `POST /threads/:id/steer` → 202. */
  readonly steer: Op<{
    readonly status: 'steered' | 'queued';
    readonly promptId: string;
  }>;
  /** `POST /threads/:id/resume` → 202. */
  readonly resume: Op<Thread>;
  /** `POST /threads/:id/rewind` → 202. */
  readonly rewind: Op<{ readonly promptId: string }>;
  /** `POST /threads/:id/compact`. */
  readonly compact: Op<{
    readonly status: 'compacted';
    readonly condensedMessages: number;
    readonly retainedMessages: number;
    readonly tokensFreed: number;
  }>;
  /** `POST /threads/:id/interrupt`. */
  readonly interrupt: Op<{ readonly status: 'interrupted' }>;
  /** `GET /threads/:id/events`. */
  readonly events: Op<ThreadEventLog>;
  /** `GET /threads/:id/usage`. */
  readonly usage: Op<ThreadUsage>;
  /** `GET /threads/:id/queue`. */
  readonly queue: Op<ThreadQueue>;
  /** `POST /threads/:id/queue/resume`. */
  readonly resumeQueue: Op<Thread>;
  /** `GET /threads/:id/queue/:promptId`. */
  readonly queuedPrompt: Op<QueuedPrompt>;
  /** `PATCH /threads/:id/queue/:promptId`. */
  readonly editQueued: Op<QueuedPrompt>;
  /** `DELETE /threads/:id/queue/:promptId` → 204. */
  readonly removeQueued: Op<undefined>;
  /** `POST /threads/:id/terminate`. */
  readonly terminate: Op<Thread>;
  /** `DELETE /threads/:id` → 204 (also for `forbidden`, Q8). */
  readonly remove: Op<undefined>;
} => ({
  queue: async ({ params }) => {
    const queue = await threads.queue(params.id ?? '');
    if (queue === undefined) return threadMissing;
    return ok(queue);
  },
  resumeQueue: async ({ params }) => {
    const result = await threads.resumeQueue(params.id ?? '');
    if (result.status === 'missing') return threadMissing;
    if (result.status !== 'resumed') {
      return refused(conflictError('thread', result.status));
    }
    return ok(result.thread);
  },
  removeQueued: async ({ params }) => {
    if (!z.uuid().safeParse(params.promptId).success) return invalidPromptId;
    const result = await threads.removeQueued({
      id: params.id ?? '',
      promptId: params.promptId ?? '',
    });
    if (result === 'missing') return threadMissing;
    if (result !== 'removed') return refused(conflictError('thread', result));
    return ok(undefined, 204);
  },
  queuedPrompt: async ({ params }) => {
    if (!z.uuid().safeParse(params.promptId).success) return invalidPromptId;
    const prompt = await threads.queuedPrompt({
      id: params.id ?? '',
      promptId: params.promptId ?? '',
    });
    if (prompt === undefined) {
      return refused({
        status: 404,
        code: 'unknown_prompt',
        message: 'This prompt is no longer queued.',
      });
    }
    return ok(prompt);
  },
  editQueued: async ({ params, body }) => {
    const input = editInput.safeParse(body);
    if (!input.success || !z.uuid().safeParse(params.promptId).success) {
      return refused({
        status: 422,
        code: 'invalid_prompt',
        message: 'A prompt ID, non-empty text and its revision are required.',
      });
    }
    const result = await threads.editQueued({
      id: params.id ?? '',
      promptId: params.promptId ?? '',
      text: input.data.text,
      revision: input.data.revision,
    });
    if (result.status === 'updated') return ok(result.prompt);
    const message =
      result.status === 'conflict'
        ? 'This prompt was edited elsewhere. Your changes have not been saved.'
        : result.status === 'not_editable'
          ? 'Only your prompts that have not started can be edited. Your changes have not been saved.'
          : 'This prompt is no longer available for editing. Your changes have not been saved.';
    return refused({
      status:
        result.status === 'missing' || result.status === 'unknown_prompt'
          ? 404
          : 409,
      code: result.status,
      message,
    });
  },
  usage: async ({ params }) => {
    const read = await usage.thread(params.id ?? '');
    if (read === undefined) return threadMissing;
    return ok(read);
  },
  update: async ({ params, body }) => {
    const input = threadInput.safeParse(body ?? {});
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_thread',
        message:
          'A Thread name, a working directory, an execution (providerId and model, with an optional effort), or a combination is required.',
      });
    }
    const id = params.id ?? '';
    const { name, cwd, providerId, model, effort } = input.data;
    let thread: Thread | undefined;
    if (name !== undefined) {
      thread = await threads.renameThread({ id, name });
      if (thread === undefined) return threadMissing;
    }
    if (cwd !== undefined) {
      const result = await threads.setThreadCwd({ id, cwd });
      if (result.status === 'missing') return threadMissing;
      if (result.status === 'inactive') return threadInactive;
      if (result.status === 'refused') {
        return refused({
          status: 400,
          code: 'invalid_cwd',
          message: cwdRefusalMessages[result.change.status],
        });
      }
      thread = result.thread;
    }
    if (providerId !== undefined && model !== undefined) {
      const result = await threads.setThreadExecution({
        id,
        providerId,
        model,
        ...(effort === undefined ? {} : { effort }),
      });
      const error = restErrors.setThreadExecution(result);
      if (error !== undefined) return refused(error);
      if (result.status === 'updated') thread = result.thread;
    }
    if (thread === undefined) {
      return refused({
        status: 422,
        code: 'invalid_thread',
        message: 'A Thread change is required.',
      });
    }
    return ok(thread);
  },
  get: async ({ params }) => {
    const thread = await threads.thread(params.id ?? '');
    if (thread === undefined) return threadMissing;
    return ok(thread);
  },
  prompt: async ({ params, body }) => {
    const input = promptInput.safeParse(body);
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_prompt',
        message: 'Only a non-empty prompt is accepted.',
      });
    }
    const result = await threads.prompt({
      id: params.id ?? '',
      prompt: input.data.prompt,
    });
    if (result.status === 'missing') return threadMissing;
    if (result.status !== 'accepted') return threadInactive;
    return ok({ promptId: result.promptId }, 202);
  },
  steer: async ({ params, body }) => {
    const input = steerInput.safeParse(body);
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_steer',
        message: 'A non-empty prompt and the running promptId are required.',
      });
    }
    const result = await threads.steer({
      id: params.id ?? '',
      prompt: input.data.prompt,
      promptId: input.data.promptId,
      ...(input.data.interrupt === undefined
        ? {}
        : { interrupt: input.data.interrupt }),
    });
    if (result.status === 'steered' || result.status === 'queued') {
      return ok({ status: result.status, promptId: result.promptId }, 202);
    }
    if (result.status === 'missing') return threadMissing;
    return threadInactive;
  },
  resume: async ({ params, body }) => {
    const input = resumeInput.safeParse(body);
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_resume',
        message: 'A promptId is required.',
      });
    }
    const result = await threads.resume({
      id: params.id ?? '',
      promptId: input.data.promptId,
    });
    if (result.status === 'missing') return threadMissing;
    if (result.status === 'unknown_prompt') return promptNotFound;
    if (result.status !== 'resumed') {
      return refused(conflictError('thread', result.status));
    }
    return ok(result.thread, 202);
  },
  rewind: async ({ params, body }) => {
    const input = rewindInput.safeParse(body);
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_rewind',
        message: 'A prompt ID and a non-empty prompt are required.',
      });
    }
    const result = await threads.rewind({
      id: params.id ?? '',
      promptId: input.data.promptId,
      prompt: input.data.prompt,
    });
    if (result.status === 'missing') return threadMissing;
    if (result.status === 'unknown_prompt') return promptNotFound;
    if (result.status === 'busy') {
      return refused({
        status: 409,
        code: 'thread_busy',
        message:
          'The Thread is running or has queued input and cannot be rewound.',
      });
    }
    if (result.status !== 'accepted') return threadInactive;
    return ok({ promptId: result.promptId }, 202);
  },
  compact: async ({ params }) => {
    const result = await threads.compact({ id: params.id ?? '' });
    if (result.status === 'missing') return threadMissing;
    if (result.status === 'busy') {
      return refused({
        status: 409,
        code: 'thread_busy',
        message:
          'The Thread is running or has queued input and cannot be compacted now.',
      });
    }
    if (result.status === 'refused') {
      return refused({
        status: 409,
        code: 'compaction_refused',
        message: compactRefusal[result.reason],
      });
    }
    if (result.status === 'failed') {
      return refused({
        status: 502,
        code: 'compaction_failed',
        message: `The compaction failed (${result.code}); the log carries the attempt.`,
      });
    }
    if (result.status !== 'compacted') {
      return refused(conflictError('thread', result.status));
    }
    return ok({
      status: result.status,
      condensedMessages: result.condensedMessages,
      retainedMessages: result.retainedMessages,
      tokensFreed: result.tokensFreed,
    });
  },
  events: async ({ params, query }) => {
    const input = eventsInput.safeParse(query);
    if (!input.success) {
      return refused({
        status: 400,
        code: 'invalid_event_cursor',
        message: 'The event cursor is invalid.',
      });
    }
    const events = await threads.threadEvents({
      id: params.id ?? '',
      afterSequence: input.data.afterSequence,
    });
    if (events === undefined) return threadMissing;
    return ok(events);
  },
  git: async ({ params }) => {
    const result = await git().status(params.id ?? '');
    if (result.status === 'missing') return threadMissing;
    if (result.status !== 'ready') {
      return ok({
        status: result.status === 'pending' ? 'pending' : 'unavailable',
      });
    }
    return ok(result.value);
  },
  branches: async ({ params }) => {
    const result = await git().branches(params.id ?? '');
    if (result.status === 'missing') return threadMissing;
    if (result.status !== 'ready') {
      return ok({
        status: result.status === 'pending' ? 'pending' : 'unavailable',
      });
    }
    return ok(result.value);
  },
  switchBranch: async ({ params, body }) => {
    const input = branchInput.safeParse(body);
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_branch',
        message: 'An existing local branch name is required.',
      });
    }
    const result = await git().switchBranch({
      threadId: params.id ?? '',
      branch: input.data.branch,
      cwd: input.data.cwd,
    });
    if (result.status === 'missing') return threadMissing;
    if (result.status === 'refused') {
      return refused({
        status: 409,
        code: 'branch_refused',
        message: result.message,
      });
    }
    if (result.status !== 'ready') return threadInactive;
    return ok(result.value);
  },
  interrupt: async ({ params, body }) => {
    const input = interruptInput.safeParse(body);
    if (!input.success) {
      return refused({
        status: 422,
        code: 'invalid_interrupt',
        message: 'A promptId is required.',
      });
    }
    const result = await threads.pause({
      id: params.id ?? '',
      promptId: input.data.promptId,
    });
    if (result === 'missing') return threadMissing;
    if (result !== 'interrupted') {
      return refused(conflictError('thread', result));
    }
    return ok({ status: result });
  },
  terminate: async ({ params }) => {
    const thread = await threads.terminateThread(params.id ?? '');
    if (thread === undefined) return threadMissing;
    return ok(thread);
  },
  remove: async ({ params }) => {
    const result = await threads.deleteThread(params.id ?? '');
    if (result === 'missing') return threadMissing;
    if (result === 'active') return refused(conflictError('thread', 'active'));
    return ok(undefined, 204);
  },
});
