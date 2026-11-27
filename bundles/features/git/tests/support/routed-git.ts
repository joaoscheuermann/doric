// `git.commands/v1` as the domain `Git`, served by `git`'s host part through
// the router, for the suites (`branches`, `change-reads`, `changes`,
// `discard`, `status`, `window`). Each call goes to the
// part's `CommandsService` on a test router (`./router-commands.ts`) whose
// fakes follow a `FakeRuntime`:
// - `thread` → `OpenThread`'s answer, `cwd` → the session's working
//   directory, `busy` → `ThreadState.busyCwds`;
// - `lease` → the Project lease's state; `dropDuringTask` → the sandbox
//   switching after `Describe` (the lease lost under the read);
// - `terminals` → `terminal/v1.List`, or no `terminal/v1` at all when unset.
// The fakes' calls are written back as the kernel fake recorded them:
// `threads` (one per `OpenThread`) and `leases` (the Project of each Project
// lease `Describe`). The answer is decoded back to the domain value by the
// codec's rules read backwards (`src/host/codec.ts`): `null` for an absent
// `upstream`/`operation`, `{repo: false}` alone, `{status}` alone for a
// refused read, `discarded` only on `failed`. A failure rejects with its Doric
// error.

import {
  type DescMessage,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import { type CallScope, fromConnectError } from 'bundle/contracts';
import type { Sandbox } from 'sandbox';

import {
  BranchesResponseSchema,
  ChangesResponseSchema,
  DiffResponseSchema,
  DiscardResponseSchema,
  FileDiffResponseSchema,
  StatusResponseSchema,
  SwitchBranchResponseSchema,
} from '../../src/contracts/gen/doric/git/commands/v1/commands_pb.js';
import type { Git } from '../../src/contracts/index.js';
import { type CommandsHarness, commandsHarness } from './router-commands.js';
import type { FakeRuntime } from './runtime.js';

type Json = Record<string, JsonValue>;

/** `message` as JSON with every implicit field emitted. */
const jsonOf = <Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): Json => toJson(schema, message, { alwaysEmitImplicit: true }) as Json;

/** A `ThreadGit` message as the domain summary. */
const threadGitOf = (value: Json): JsonValue =>
  value.repo === true
    ? {
        ...value,
        upstream: value.upstream ?? null,
        operation: value.operation ?? null,
      }
    : { repo: false };

/** A `ChangesRead`/`DiffRead`/`FileDiffRead`: a refused read is its `status` alone. */
const readOf = (value: Json): JsonValue =>
  value.status === 'read' ? value : { status: value.status ?? null };

/** `{status, value?}` with `value` decoded by `decode` when present. */
const outcomeOf = (
  answer: Json,
  decode: (value: Json) => JsonValue = (value) => value,
): JsonValue =>
  answer.value === undefined
    ? { status: answer.status ?? null }
    : { status: answer.status ?? null, value: decode(answer.value as Json) };

/** `SwitchBranch`/`Discard`: `refused` and `failed` carry their sentence. */
const settledOf = (answer: Json): JsonValue => {
  if (answer.status === 'refused')
    return { status: answer.status, message: answer.message ?? null };
  if (answer.status === 'failed')
    return {
      status: answer.status,
      message: answer.message ?? null,
      discarded: answer.discarded ?? [],
    };
  return outcomeOf(answer);
};

/** The fakes' state for the next call, read from `runtime`. */
const follow = (h: CommandsHarness, runtime: FakeRuntime): void => {
  h.state.thread = runtime.thread;
  h.state.cwd = runtime.cwd;
  h.state.busyCwds = [...runtime.busy];
  h.state.terminals = [...(runtime.terminals ?? [])];
  h.state.lease = runtime.lease;
  h.state.sandboxId = 'sandbox-1';
  h.state.switchAfterDescribe = runtime.dropDuringTask
    ? 'sandbox-dropped'
    : undefined;
};

/** Writes the fakes' calls since `from` back into `runtime`'s records. */
const record = (h: CommandsHarness, runtime: FakeRuntime, from: number) => {
  for (const call of h.calls.slice(from)) {
    const request = call.request as Json;

    if (call.service === 'workspace' && call.method === 'openThread') {
      runtime.threads.push({
        threadId: String(request.threadId ?? ''),
        options: {
          exclusive: request.exclusive === true,
          ...(request.refreshHint === true ? { refreshHint: true } : {}),
          ...(request.resume === true ? { resume: true } : {}),
        },
      });
    }

    const target = request.target as Json | undefined;

    if (
      call.service === 'lease' &&
      call.method === 'describe' &&
      target?.threadSessionId === undefined
    ) {
      runtime.leases.push(call.scope?.projectId);
    }
  }
};

export interface RoutedGit {
  /** `git.commands/v1` under `scope`, as the domain `Git`. */
  git(scope: CallScope): Git;
  /** Stops the router. */
  dispose(): Promise<void>;
}

/**
 * `git.commands/v1` of the routed part over `sandbox`, its fakes following
 * `runtime` at each call. The router starts with the first call.
 */
export const routedGit = (
  sandbox: Sandbox,
  runtime: FakeRuntime,
): RoutedGit => {
  const h = commandsHarness({
    sandbox,
    terminal: runtime.terminals !== undefined,
  });
  let started: Promise<void> | undefined;

  const call = async <T>(
    scope: CallScope,
    send: (client: ReturnType<CommandsHarness['client']>) => Promise<JsonValue>,
  ): Promise<T> => {
    started ??= h.activate();
    await started;
    follow(h, runtime);
    const from = h.calls.length;

    try {
      return (await send(h.client(scope))) as T;
    } catch (error) {
      throw error instanceof ConnectError ? fromConnectError(error) : error;
    } finally {
      record(h, runtime, from);
    }
  };

  return {
    git: (scope) => ({
      status: (threadId) =>
        call(scope, async (client) =>
          outcomeOf(
            jsonOf(StatusResponseSchema, await client.status({ threadId })),
            threadGitOf,
          ),
        ),
      branches: (threadId) =>
        call(scope, async (client) =>
          outcomeOf(
            jsonOf(BranchesResponseSchema, await client.branches({ threadId })),
          ),
        ),
      switchBranch: (input) =>
        call(scope, async (client) =>
          settledOf(
            jsonOf(
              SwitchBranchResponseSchema,
              await client.switchBranch(input),
            ),
          ),
        ),
      discard: ({ threadId, cwd, repository, paths }) =>
        call(scope, async (client) =>
          settledOf(
            jsonOf(
              DiscardResponseSchema,
              await client.discard({
                threadId,
                cwd,
                repository,
                ...(paths === undefined
                  ? { all: true }
                  : { all: false, paths: [...paths] }),
              }),
            ),
          ),
        ),
      changes: (input) =>
        call(scope, async (client) =>
          outcomeOf(
            jsonOf(ChangesResponseSchema, await client.changes(input)),
            readOf,
          ),
        ),
      diff: (input) =>
        call(scope, async (client) =>
          outcomeOf(
            jsonOf(DiffResponseSchema, await client.diff(input)),
            readOf,
          ),
        ),
      fileDiff: (input) =>
        call(scope, async (client) =>
          outcomeOf(
            jsonOf(FileDiffResponseSchema, await client.fileDiff(input)),
            readOf,
          ),
        ),
    }),
    dispose: async () => {
      if (started !== undefined) await started.catch(() => undefined);
      await h.router.control.stop();
    },
  };
};
