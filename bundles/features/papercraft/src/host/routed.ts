// The routed adapters of `papercraft`'s host part as a process (phase 3, S57):
// `files/v1`, `runtime.lease/v1`, `runtime.threads/v1` and `events/v1` over the
// router as `PapercraftPorts`, and the registrations `activate` tracks.

import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';

import { create, toJson } from '@bufbuild/protobuf';
import { anyPack, ValueSchema } from '@bufbuild/protobuf/wkt';
import type { Client } from '@connectrpc/connect';
import { type Call, ContractError } from 'bundle/contracts';
import { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import {
  contractErrorOf,
  type HostContext,
  type HostServices,
} from 'bundle/host';
import { FilesService } from 'files/contracts/gen/doric/files/v1/files_pb.js';
import { readThreadEventLog, type SteerResult } from 'runtime/contracts';
import {
  type SteerResult as SteerResultMessage,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';

import { PapercraftCwdSchema } from '../contracts/gen/doric/papercraft/cwd/v1/cwd_pb.js';
import {
  cwdEvent,
  type FilesContentRead,
  type LeaseOutcome,
} from '../contracts/index.js';
import { routedPapercraftLease } from './lease.js';
import type { BytesReadOutcome, PapercraftPorts } from './ports.js';
import { PAPERCRAFT_SKILL_OPTIONS, type PapercraftSkill } from './skill.js';

/** The asynchronous context at load: outside every handler's call. */
const outside = AsyncLocalStorage.snapshot();

/** Runs `work` outside every handler's call (the context at load), as `openui`'s (D2). */
export const detached = <T>(work: () => T): T => outside(work);

/** Runs `work`, rethrowing a routed call's failure as its `ContractError`. */
const routed = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw contractErrorOf(error);
  }
};

/** Runs `work` in the current context with `call`, `detached` without one (D2). */
const within = <T>(
  call: Call | undefined,
  work: () => Promise<T>,
): Promise<T> =>
  call === undefined ? detached(() => routed(work)) : routed(work);

const invalidOutput = (message: string): ContractError =>
  new ContractError('invalid_output', message);

/** Whether `status` is one of `statuses`, narrowing it. */
const isOneOf = <S extends string>(
  status: string,
  statuses: readonly S[],
): status is S => (statuses as readonly string[]).includes(status);

const LEASE_FAILURES = [
  'pending',
  'unavailable',
  'expired',
  'missing',
] as const;

const READ_REFUSALS = ['not_found', 'not_file', 'invalid_path'] as const;

const STEER_REFUSALS = ['missing', 'inactive', 'forbidden'] as const;

/** A lease-dependent answer's `status`/`value` as a `LeaseOutcome` of `answerOf(value)`. */
const leaseOutcomeOf = async <V, T>(
  status: string,
  value: V | undefined,
  answerOf: (value: V) => T | Promise<T>,
): Promise<LeaseOutcome<T>> => {
  if (status === 'ready') {
    if (value === undefined)
      throw invalidOutput('A ready answer has no value.');

    return { status, value: await answerOf(value) };
  }

  if (isOneOf(status, LEASE_FAILURES)) return { status };

  throw invalidOutput(`Unknown lease status "${status}".`);
};

/** A read refusal `status`, or `invalid_output`. */
const readRefusalOf = (
  status: string,
): { readonly status: (typeof READ_REFUSALS)[number] } => {
  if (isOneOf(status, READ_REFUSALS)) return { status };

  throw invalidOutput(`Unknown read status "${status}".`);
};

/** A `SteerResult` message as today's union. */
const steerResultOf = (result: SteerResultMessage | undefined): SteerResult => {
  const status = result?.status ?? '';

  if (status === 'steered' || status === 'queued') {
    if (result?.promptId === undefined) {
      throw invalidOutput(`A ${status} answer has no promptId.`);
    }

    return { status, promptId: result.promptId };
  }

  if (isOneOf(status, STEER_REFUSALS)) return { status };

  throw invalidOutput(`Unknown steer status "${status}".`);
};

/**
 * `PapercraftPorts` over the router; clients created on first use; a method with `call` runs in the current context,
 * without one `detached`; failures reject with `contractErrorOf`'s `ContractError`.
 * - `files.content`: `FilesService.Content{path}` with scope `{projectId}` → today's `LeaseOutcome<FilesContentRead>`.
 * - `files.readBytes`: `ReadBytes{path}`, scope `{projectId}`: the head's status/value, the chunks concatenated; a stream
 *   without a head first rejects `invalid_output`.
 * - `lease`: `routedPapercraftLease(services)`.
 * - `threads.eventsAfter`: `ThreadEvents{id, afterSequence}`; absent log → `undefined`; `event` as
 *   `toJson(ValueSchema, event)`. `threads.instruct`: `Instruct{…, retain: true}` → `SteerResult` (a
 *   `steered`/`queued` answer without `promptId` rejects `invalid_output`).
 * - `appendCwd`: `services.use(EventsService, {scope}).append({type: cwdEvent.type, payload: anyPack(PapercraftCwdSchema,
 *   {cwd})})`.
 */
export const routedPapercraftPorts = (
  services: Pick<HostServices, 'use'>,
): PapercraftPorts => {
  const filesClients = new Map<string, Client<typeof FilesService>>();
  const files = (projectId: string): Client<typeof FilesService> => {
    let client = filesClients.get(projectId);
    if (client === undefined) {
      client = services.use(FilesService, { scope: { projectId } });
      filesClients.set(projectId, client);
    }

    return client;
  };
  let threadsClient: Client<typeof ThreadsService> | undefined;
  const threads = () => (threadsClient ??= services.use(ThreadsService));

  return {
    files: {
      content: (path, { projectId, call }) =>
        within(call, async () => {
          const { status, value } = await files(projectId).content({ path });

          return leaseOutcomeOf(
            status,
            value,
            (read): FilesContentRead =>
              read.status === 'read'
                ? {
                    status: 'read',
                    path: read.path ?? path,
                    content: read.content ?? '',
                    truncated: read.truncated ?? false,
                    binary: read.binary ?? false,
                  }
                : readRefusalOf(read.status),
          );
        }),
      readBytes: (path, { projectId, call }) =>
        within(call, async () => {
          const stream = files(projectId)
            .readBytes({ path })
            [Symbol.asyncIterator]();
          const first = await stream.next();

          if (first.done === true || first.value.item.case !== 'head') {
            await stream.return?.();
            throw invalidOutput(
              'A ReadBytes stream did not start with a head.',
            );
          }

          const head = first.value.item.value;

          return leaseOutcomeOf(
            head.status,
            head.value,
            async (read): Promise<BytesReadOutcome> => {
              if (read.status !== 'read') return readRefusalOf(read.status);

              const chunks: Uint8Array[] = [];
              for (;;) {
                const next = await stream.next();
                if (next.done === true) break;
                if (next.value.item.case === 'chunk') {
                  chunks.push(next.value.item.value);
                }
              }

              return {
                status: 'read',
                bytes: new Uint8Array(Buffer.concat(chunks)),
                truncated: read.truncated ?? false,
              };
            },
          );
        }),
    },
    lease: routedPapercraftLease(services),
    threads: {
      eventsAfter: (threadId, afterSequence, call) =>
        within(call, async () => {
          const threadEventLog = await readThreadEventLog(threads(), {
            id: threadId,
            afterSequence,
          });

          if (threadEventLog === undefined) return undefined;

          return {
            events: threadEventLog.events.map((entry) => ({
              sequence: entry.sequence,
              type: entry.type,
              event:
                entry.event === undefined
                  ? undefined
                  : toJson(ValueSchema, entry.event),
            })),
            lastSequence: threadEventLog.lastSequence,
          };
        }),
      instruct: (input, call) =>
        within(call, async () =>
          steerResultOf(
            (
              await threads().instruct({
                id: input.id,
                prompt: input.prompt,
                reason: input.reason,
                promptId: input.promptId,
                retain: true,
              })
            ).steerResult,
          ),
        ),
    },
    appendCwd: (scope, cwd, call) =>
      within(call, async () => {
        await services.use(EventsService, { scope: { ...scope } }).append({
          type: cwdEvent.type,
          payload: anyPack(
            PapercraftCwdSchema,
            create(PapercraftCwdSchema, { cwd }),
          ),
        });
      }),
  };
};

/** Tracks `events/v1.Register{type: 'papercraft.cwd/v1', messageType: PapercraftCwdSchema.typeName}` (no sink).
 * Rejects with the refusal (`registration_conflict`, `invalid_input`). */
export const registerCwdEvent = async (
  context: Pick<HostContext, 'registrations'>,
): Promise<void> => {
  await context.registrations.track(EventsService, (client) =>
    routed(() =>
      client.register({
        type: cwdEvent.type,
        messageType: PapercraftCwdSchema.typeName,
      }),
    ),
  );
};

/** Tracks `skills/v1.Register{skill, options: PAPERCRAFT_SKILL_OPTIONS}`. Resolves `true` when registered; `false`,
 * tracking nothing, when the call rejects (any error: PC33, D8). Never rejects. */
export const registerSkill = async (
  context: Pick<HostContext, 'registrations'>,
  skill: PapercraftSkill,
): Promise<boolean> => {
  try {
    await context.registrations.track(SkillsService, (client) =>
      routed(() =>
        client.register({
          skill: {
            name: skill.name,
            description: skill.description,
            body: skill.body,
            allowedTools: [...skill.allowedTools],
          },
          options: PAPERCRAFT_SKILL_OPTIONS,
        }),
      ),
    );

    return true;
  } catch {
    // PC33 (D8): a refused skill is left out; nothing is tracked, so no replay.
    return false;
  }
};
