import { ContractError } from 'bundle/contracts';

import {
  type BranchResult,
  type CwdResult,
  type DeleteResult,
  type EditQueueResult,
  type PromptAcceptResult,
  type RemoveQueuedResult,
  type ResumeResult,
  type RewindResult,
  storageMessage,
  type ThreadCreateResult,
} from './model.js';
import type { InterruptResult } from './threads.js';

/*
 * The REST error each runtime contract outcome answers (stage 9 R-ERR). The
 * runtime contracts return outcome unions; the transport routes turn them
 * into `{ error: { code, message } }` with an HTTP status, and the desktop UI
 * shows that message today. A UI adapter that calls the contracts over the
 * bridge maps each outcome through these functions, so the user reads the
 * same text and the layout still sees the 409 it retries a delete on.
 * `bundles/foundation/transport/tests/rest-errors.test.ts` drives every route with every
 * outcome and compares the answer with this table.
 */

/** One REST error envelope with the status the route answers it with. */
export interface RestError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** The named resources whose routes answer the same not-found and conflict. */
export type RestResource = 'project' | 'thread' | 'credential';

/** `missing(response, kind)` of the routes. */
export const notFoundError = (kind: RestResource): RestError => ({
  status: 404,
  code: `${kind}_not_found`,
  message: `The ${kind} was not found.`,
});

/** `conflict(response, kind, reason)` of the routes. */
export const conflictError = (
  kind: RestResource,
  reason: string,
): RestError => ({
  status: 409,
  code: `${kind}_${reason}`,
  message:
    reason === 'storage_low'
      ? storageMessage
      : `The ${kind} cannot perform this operation.`,
});

/** A resume or rewind of a prompt the Thread does not hold. */
export const promptNotFoundError: RestError = {
  status: 404,
  code: 'prompt_not_found',
  message: 'The prompt was not found in this Thread.',
};

/** What one refused working directory means, in one sentence per outcome. */
export const cwdRefusalMessages: Readonly<
  Record<'outside' | 'missing' | 'not-directory', string>
> = {
  outside: 'The working directory must stay inside the workspace.',
  missing: 'No such directory.',
  'not-directory': 'The working directory must be a directory.',
};

const terminalMissing: RestError = {
  status: 404,
  code: 'terminal_missing',
  message: 'Terminal no longer exists.',
};

const queuedEditMessages: Readonly<Record<string, string>> = {
  conflict:
    'This prompt was edited elsewhere. Your changes have not been saved.',
  not_editable:
    'Only your prompts that have not started can be edited. Your changes have not been saved.',
};

/** A record read: absent means the resource was not found. */
const found =
  (kind: RestResource) =>
  (value: unknown): RestError | undefined =>
    value === undefined ? notFoundError(kind) : undefined;

const deleted =
  (kind: 'project' | 'thread') =>
  (result: DeleteResult): RestError | undefined =>
    result === 'missing'
      ? notFoundError(kind)
      : result === 'active'
        ? conflictError(kind, 'active')
        : undefined;

/**
 * The REST error of each runtime contract outcome, by the route that answers
 * it; `undefined` is the route's success answer.
 */
export const restErrors = {
  // runtime/v1 ---------------------------------------------------------------
  /** `GET /projects/:id`, `PATCH /projects/:id[/color]`, `POST …/terminate`. */
  project: found('project'),
  /** `DELETE /projects/:id`. */
  deleteProject: deleted('project'),
  // runtime.threads/v1 -------------------------------------------------------
  /** `POST /projects/:id/threads`. */
  createThread: (result: ThreadCreateResult): RestError | undefined =>
    result.status === 'created'
      ? undefined
      : result.status === 'missing'
        ? notFoundError('project')
        : conflictError('thread', result.status),
  /** `GET /projects/:id/threads` of a missing Project. */
  threads: found('project'),
  /**
   * `GET /threads/:id`, the rename half of `PATCH /threads/:id`,
   * `POST …/terminate`, `GET …/queue`, `GET …/usage` and `GET …/events`.
   */
  thread: found('thread'),
  /** The working-directory half of `PATCH /threads/:id`. */
  setThreadCwd: (result: CwdResult): RestError | undefined =>
    result.status === 'updated'
      ? undefined
      : result.status === 'missing'
        ? notFoundError('thread')
        : result.status === 'inactive'
          ? conflictError('thread', 'inactive')
          : {
              status: 400,
              code: 'invalid_cwd',
              message: cwdRefusalMessages[result.change.status],
            },
  /** `DELETE /threads/:id`. */
  deleteThread: deleted('thread'),
  /** `POST /threads/:id/prompt`: any refusal but missing is `inactive`. */
  prompt: (result: PromptAcceptResult): RestError | undefined =>
    result.status === 'accepted'
      ? undefined
      : result.status === 'missing'
        ? notFoundError('thread')
        : conflictError('thread', 'inactive'),
  /** `POST /threads/:id/resume`. */
  resume: (result: ResumeResult): RestError | undefined =>
    result.status === 'resumed'
      ? undefined
      : result.status === 'missing'
        ? notFoundError('thread')
        : result.status === 'unknown_prompt'
          ? promptNotFoundError
          : conflictError('thread', result.status),
  /** `POST /threads/:id/rewind`. */
  rewind: (result: RewindResult): RestError | undefined =>
    result.status === 'accepted'
      ? undefined
      : result.status === 'missing'
        ? notFoundError('thread')
        : result.status === 'unknown_prompt'
          ? promptNotFoundError
          : result.status === 'busy'
            ? {
                status: 409,
                code: 'thread_busy',
                message:
                  'The Thread is running or has queued input and cannot be rewound.',
              }
            : conflictError('thread', 'inactive'),
  /** `POST /threads/:id/interrupt`. */
  pause: (result: InterruptResult): RestError | undefined =>
    result === 'interrupted'
      ? undefined
      : result === 'missing'
        ? notFoundError('thread')
        : conflictError('thread', result),
  /** `POST /threads/:id/queue/resume`. */
  resumeQueue: (result: ResumeResult): RestError | undefined =>
    result.status === 'resumed'
      ? undefined
      : result.status === 'missing'
        ? notFoundError('thread')
        : conflictError('thread', result.status),
  /** `DELETE /threads/:id/queue/:promptId`. */
  removeQueued: (result: RemoveQueuedResult): RestError | undefined =>
    result === 'removed'
      ? undefined
      : result === 'missing'
        ? notFoundError('thread')
        : conflictError('thread', result),
  /** `GET /threads/:id/queue/:promptId`. */
  queuedPrompt: (value: unknown): RestError | undefined =>
    value === undefined
      ? {
          status: 404,
          code: 'unknown_prompt',
          message: 'This prompt is no longer queued.',
        }
      : undefined,
  /** `PATCH /threads/:id/queue/:promptId`. */
  editQueued: (result: EditQueueResult): RestError | undefined =>
    result.status === 'updated'
      ? undefined
      : {
          status:
            result.status === 'missing' || result.status === 'unknown_prompt'
              ? 404
              : 409,
          code: result.status,
          message:
            queuedEditMessages[result.status] ??
            'This prompt is no longer available for editing. Your changes have not been saved.',
        },
  // runtime.lease/v1 ---------------------------------------------------------
  /** `POST /threads/:id/branches` (switch); the reads stay data (R-DATA). */
  switchBranch: (result: BranchResult): RestError | undefined =>
    result.status === 'ready'
      ? undefined
      : result.status === 'missing'
        ? notFoundError('thread')
        : result.status === 'refused'
          ? { status: 409, code: 'branch_refused', message: result.message }
          : conflictError('thread', 'inactive'),
  // runtime.terminals/v1 -----------------------------------------------------
  /** `POST /threads/:id/terminals`. */
  createTerminal: (value: unknown): RestError | undefined =>
    value === undefined
      ? {
          status: 409,
          code: 'terminal_unavailable',
          message: 'The Thread has no active sandbox.',
        }
      : undefined,
  /** `GET /terminals/:id`. */
  terminalSnapshot: (value: unknown): RestError | undefined =>
    value === undefined ? terminalMissing : undefined,
  /** `POST /terminals/:id/input` and `…/resize`. */
  terminalWrite: (written: boolean): RestError | undefined =>
    written ? undefined : terminalMissing,
} as const;

/** The error a UI adapter throws for one REST error (R-ERR). */
export const restContractError = (error: RestError): ContractError =>
  new ContractError(error.code, error.message, { status: error.status });
