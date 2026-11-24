// The routed adapters of `openui`'s host part as a process (phase 3, S56):
// `runtime.threads/v1` and `events/v1` over the router as `OpenuiPorts`, and
// the registrations `activate` tracks.

import { AsyncLocalStorage } from 'node:async_hooks';

import { create, toJson } from '@bufbuild/protobuf';
import { anyPack, ValueSchema } from '@bufbuild/protobuf/wkt';
import type { Client } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import {
  contractErrorOf,
  type HostContext,
  type HostServices,
} from 'bundle/host';
import {
  type PromptResult,
  type ResumeResult,
  readThreadEventLog,
  type SteerResult,
} from 'runtime/contracts';
import {
  type PromptResult as PromptResultMessage,
  type SteerResult as SteerResultMessage,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';

import { OpenuiAnsweredSchema } from '../contracts/gen/doric/openui/answered/v1/answered_pb.js';
import { answeredEvent } from '../contracts/index.js';
import type { OpenuiPorts } from './ports.js';
import { OPENUI_SKILL_OPTIONS, type OpenuiSkill } from './skill.js';

/** The asynchronous context at load: outside every handler's call. */
const outside = AsyncLocalStorage.snapshot();

/** Runs `work` outside every handler's call (the context at load): its calls inherit no deadline, signal, scope or trace (D5). */
export const detached = <T>(work: () => T): T => outside(work);

/** Runs `work`, rethrowing a routed call's failure as its `ContractError`. */
const routed = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw contractErrorOf(error);
  }
};

const invalidOutput = (message: string): ContractError =>
  new ContractError('invalid_output', message);

/** Whether `status` is one of `statuses`, narrowing it. */
const isOneOf = <S extends string>(
  status: string,
  statuses: readonly S[],
): status is S => (statuses as readonly string[]).includes(status);

const REFUSALS = ['missing', 'inactive', 'forbidden'] as const;

const RESUME_STATUSES = [
  'resumed',
  'missing',
  'inactive',
  'busy',
  'unknown_prompt',
  'storage_low',
] as const;

/** A `SteerResult` message as today's union. */
const steerResultOf = (result: SteerResultMessage | undefined): SteerResult => {
  const status = result?.status ?? '';

  if (status === 'steered' || status === 'queued') {
    if (result?.promptId === undefined) {
      throw invalidOutput(`A ${status} answer has no promptId.`);
    }

    return { status, promptId: result.promptId };
  }

  if (isOneOf(status, REFUSALS)) return { status };

  throw invalidOutput(`Unknown steer status "${status}".`);
};

/** A `PromptResult` message as today's union. */
const promptResultOf = (
  result: PromptResultMessage | undefined,
): PromptResult => {
  const status = result?.status ?? '';

  if (status === 'accepted') {
    if (result?.promptId === undefined) {
      throw invalidOutput('An accepted answer has no promptId.');
    }

    return { status, promptId: result.promptId };
  }

  if (isOneOf(status, REFUSALS)) return { status };

  throw invalidOutput(`Unknown prompt status "${status}".`);
};

/**
 * `OpenuiPorts` over the router, clients created on first use. Each call runs
 * in the current context (a handler's call: its deadline, signal, scope),
 * except `instruct` without `call`, which runs `detached`. Failures reject
 * with `contractErrorOf`'s `ContractError`.
 * - `rows`: `ThreadEvents{id, afterSequence: 0}`; absent `threadEventLog` →
 *   `[]`; each `event` as `toJson(ValueSchema, event)`.
 * - `thread`: `Thread{id}` → `{projectId, origin?, activePromptId?}` or
 *   `undefined`.
 * - `steer` / `instruct` / `prompt`: `steerResult` / `promptResult` as the
 *   domain unions; a `steered`/`queued`/`accepted` answer without `promptId`
 *   rejects `invalid_output`.
 * - `queue`: `threadQueue` or `undefined`; `resumeQueue`: `{status}`.
 * - `appendAnswered`: `services.use(EventsService, {scope}).append({type:
 *   answeredEvent.type, payload: anyPack(OpenuiAnsweredSchema, payload)})`.
 */
export const routedOpenuiPorts = (
  services: Pick<HostServices, 'use'>,
): OpenuiPorts => {
  let threadsClient: Client<typeof ThreadsService> | undefined;
  const threads = () => (threadsClient ??= services.use(ThreadsService));

  const instruct: OpenuiPorts['threads']['instruct'] = (input) =>
    routed(async () =>
      steerResultOf(
        (
          await threads().instruct({
            id: input.id,
            prompt: input.prompt,
            reason: input.reason,
            ...(input.promptId === undefined
              ? {}
              : { promptId: input.promptId }),
          })
        ).steerResult,
      ),
    );

  return {
    threads: {
      rows: (threadId) =>
        routed(async () => {
          const threadEventLog = await readThreadEventLog(threads(), {
            id: threadId,
            afterSequence: 0,
          });

          return (threadEventLog?.events ?? []).map((entry) => ({
            projectId: entry.projectId,
            threadId: entry.threadId,
            type: entry.type,
            event:
              entry.event === undefined
                ? undefined
                : toJson(ValueSchema, entry.event),
          }));
        }),
      thread: (id) =>
        routed(async () => {
          const { thread } = await threads().thread({ id });

          if (thread === undefined) return undefined;

          return {
            projectId: thread.projectId,
            ...(thread.origin === undefined ? {} : { origin: thread.origin }),
            ...(thread.activePromptId === undefined
              ? {}
              : { activePromptId: thread.activePromptId }),
          };
        }),
      steer: (input) =>
        routed(async () =>
          steerResultOf(
            (
              await threads().steer({
                id: input.id,
                prompt: input.prompt,
                promptId: input.promptId,
              })
            ).steerResult,
          ),
        ),
      queue: (id) =>
        routed(async () => {
          const { threadQueue } = await threads().queue({ id });

          if (threadQueue === undefined) return undefined;

          return {
            paused: threadQueue.paused,
            ...(threadQueue.current === undefined
              ? {}
              : { current: threadQueue.current }),
            ...(threadQueue.resumable === undefined
              ? {}
              : { resumable: threadQueue.resumable }),
            items: threadQueue.items,
          };
        }),
      resumeQueue: (id) =>
        routed(async (): Promise<Pick<ResumeResult, 'status'>> => {
          const status =
            (await threads().resumeQueue({ id })).resumeResult?.status ?? '';

          if (!isOneOf(status, RESUME_STATUSES)) {
            throw invalidOutput(`Unknown resume status "${status}".`);
          }

          return { status };
        }),
      prompt: (input) =>
        routed(async () =>
          promptResultOf(
            (await threads().prompt({ id: input.id, prompt: input.prompt }))
              .promptResult,
          ),
        ),
      instruct: (input, call) =>
        call === undefined ? detached(() => instruct(input)) : instruct(input),
    },
    appendAnswered: (scope, payload) =>
      routed(async () => {
        await services.use(EventsService, { scope: { ...scope } }).append({
          type: answeredEvent.type,
          payload: anyPack(
            OpenuiAnsweredSchema,
            create(OpenuiAnsweredSchema, {
              questionPromptId: payload.questionPromptId,
              digest: payload.digest,
              answers: payload.answers.map((answer) => ({
                id: answer.id,
                options: [...answer.options],
                ...(answer.other === undefined ? {} : { other: answer.other }),
              })),
            }),
          ),
        });
      }),
  };
};

/**
 * Tracks `events/v1.Register{type: answeredEvent.type, messageType:
 * OpenuiAnsweredSchema.typeName}` (replayed after a `core` restart; no sink,
 * D6). Rejects with the refusal (`registration_conflict`, `invalid_input`).
 */
export const registerAnsweredEvent = async (
  context: Pick<HostContext, 'registrations'>,
): Promise<void> => {
  await context.registrations.track(EventsService, (client) =>
    routed(() =>
      client.register({
        type: answeredEvent.type,
        messageType: OpenuiAnsweredSchema.typeName,
      }),
    ),
  );
};

/**
 * Tracks `skills/v1.Register{skill: {name, description, body, allowedTools:
 * []}, options: OPENUI_SKILL_OPTIONS}`. Rejects with the refusal
 * (`duplicate_skill`, `invalid_input` for a blank body). Not unregistered at
 * deactivate: `core` drops the instance's skills when it stops.
 */
export const registerSkill = async (
  context: Pick<HostContext, 'registrations'>,
  skill: OpenuiSkill,
): Promise<void> => {
  await context.registrations.track(SkillsService, (client) =>
    routed(() =>
      client.register({
        skill: {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          allowedTools: [...skill.allowedTools],
        },
        options: OPENUI_SKILL_OPTIONS,
      }),
    ),
  );
};
