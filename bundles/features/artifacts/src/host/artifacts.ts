// `artifacts/v1` (host): the registry of the Project's reviewable deliverables.
//
// A revision is immutable: `revise` appends, never rewrites, so the node and
// the comments of an earlier revision stay valid — and its bytes live in a
// directory of their own. The work copy lives in the Project's sandbox
// (`store.ts`) and every transition publishes one durable event through
// `events/v1`, which appends to the Thread log the runtime already owns. The
// registry never interprets the payload of a kind: the anchors and the ready
// entries are the caller's, and a payload is the kind's own, validated by the
// schema the kind registered and materialized by the provider the kind
// declared. The bytes of a revision reach the work copy once — through
// `files` or the kind's materialization — always verified against the entry's
// hash, as bytes, and never inside an event.
//
// A transition is all or nothing. Everything that can be refused — the call
// scope the event needs, the input, the kind's payload, the hashes and the
// event body — is checked before the first write; then the revision's files,
// the manifest and the event follow, and a failure after a write undoes what
// that transition wrote. Transitions of one artifact run one at a time.
//
// The review state is per revision: under `request`, `approve` makes that one
// revision `approved` and a new revision starts `open`; under `proceed` there
// is no approval at all. `awaitApproval` is the seam a kind's tool waits on
// before it writes into the Project's code, and `apply` refuses, under
// `request`, a revision nobody approved.

import { Buffer } from 'node:buffer';

import {
  type Call,
  type CallScope,
  ContractError,
  defineMethod,
  defineService,
  type EventDefinition,
  EventsV1,
  type Services,
  SettingsV1,
} from 'bundle/contracts';
import { readRuntimeScope } from 'runtime/contracts';

import {
  type ArtifactEntry,
  type ArtifactFile,
  type ArtifactReadEntry,
  type ArtifactRecord,
  type ArtifactReviewPolicySettings,
  type ArtifactReviewPolicyValue,
  type ArtifactRevisionRead,
  ArtifactsV1,
  type ArtifactTarget,
  artifactApprovalScope,
  artifactReviewPolicy,
  artifactsAppliedEvent,
  artifactsApprovedEvent,
  artifactsCreatedEvent,
  artifactsMethods,
  artifactsRevisedEvent,
  isArtifactEntryPath,
  reviewPolicyOf,
} from '../contracts/index.js';
import { artifactIdPattern, newArtifactId } from './ids.js';
import type { ArtifactKindRegistryState } from './kinds.js';
import {
  createArtifactStore,
  DOT_DORIC_IGNORE,
  isLeaseUnavailable,
  type RevisionFile,
  type StoredArtifact,
  type StoredArtifactRevision,
  sha256Of,
} from './store.js';

/**
 * A record or a payload without the keys whose value is `undefined`: an absent
 * optional field stays absent, in the answer and in the durable event body.
 */
const definedFields = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;

const revisionIn = (
  artifact: StoredArtifact,
  revision: number,
): StoredArtifactRevision | undefined =>
  artifact.revisions.find((candidate) => candidate.revision === revision);

const newestRevision = (artifact: StoredArtifact): StoredArtifactRevision =>
  artifact.revisions.at(-1) as StoredArtifactRevision;

/** The artifact as one of its revisions reads, which is what every caller sees. */
const recordOf = (
  artifact: StoredArtifact,
  entry: StoredArtifactRevision,
): ArtifactRecord =>
  definedFields({
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    title: artifact.title,
    revision: entry.revision,
    revisions: artifact.revisions.length,
    targets: entry.targets,
    entries: entry.entries,
    source: entry.source,
    path: entry.path,
    entry: entry.entry,
    notes: entry.notes,
    changeNote: entry.changeNote,
    state: entry.approved === true ? 'approved' : 'open',
    createdAt: artifact.createdAt,
    createdBy: artifact.createdBy,
  });

/** What a revision keeps of the caller's declaration; absent stays absent. */
interface RevisionInput {
  readonly targets?: readonly ArtifactTarget[];
  readonly entries?: readonly ArtifactEntry[];
  readonly files?: readonly ArtifactFile[];
  readonly payload?: unknown;
  readonly source?: ArtifactRecord['source'];
  readonly path?: string;
  readonly entry?: string;
}

/** One revision fully resolved: anchors, entries, bytes and payload place. */
interface ResolvedRevision {
  readonly targets: readonly ArtifactTarget[];
  readonly entries: readonly ArtifactEntry[];
  readonly files: readonly RevisionFile[];
  /** The kind's payload as its schema parsed it, when one was sent. */
  readonly payload?: unknown;
  readonly source?: ArtifactRecord['source'];
  readonly path?: string;
  readonly entry?: string;
}

/**
 * The bytes of a revision's files, each verified against the entry of the
 * same path: a file that names no entry, or whose bytes hash otherwise, is
 * refused before anything is written.
 */
const verifiedFiles = (
  artifactId: string,
  entries: readonly ArtifactEntry[],
  files: readonly ArtifactFile[],
): RevisionFile[] =>
  files.map((file) => {
    const entry = entries.find((candidate) => candidate.path === file.path);

    if (entry === undefined) {
      throw new ContractError(
        'invalid_input',
        `File "${file.path}" names no entry of the revision.`,
        { artifactId, path: file.path },
      );
    }

    const bytes = new Uint8Array(Buffer.from(file.base64, 'base64'));

    if (sha256Of(bytes) !== entry.sha256) {
      throw new ContractError(
        'invalid_input',
        `File "${file.path}" does not hash to the entry it names.`,
        { artifactId, path: file.path, sha256: entry.sha256 },
      );
    }

    return { path: file.path, bytes };
  });

/** Refuses entries a kind's own materialization named outside the revision. */
const checkedEntries = (
  artifactId: string,
  entries: readonly ArtifactEntry[],
): readonly ArtifactEntry[] => {
  for (const entry of entries) {
    if (!isArtifactEntryPath(entry.path)) {
      throw new ContractError(
        'invalid_input',
        `Entry path "${entry.path}" leaves the artifact's directory.`,
        { artifactId, path: entry.path },
      );
    }
  }

  return entries;
};

/**
 * Resolves one revision's anchors, entries and bytes. Ready entries win; a
 * payload is the kind's own — parsed by the schema the kind registered and
 * materialized, as parsed, by the provider it declared — and fills in the
 * entries (and the bytes) the caller did not give. Absent anchors, entries
 * and payload places carry over from the previous revision, as `revise`
 * promises.
 */
const resolveRevision = async (
  input: RevisionInput,
  identity: {
    readonly kind: string;
    readonly artifactId: string;
    readonly revision: number;
    readonly title: string;
  },
  previous: StoredArtifactRevision | undefined,
  kinds: ArtifactKindRegistryState,
  call: Call,
): Promise<ResolvedRevision> => {
  const { kind: kindId, artifactId } = identity;
  let targets = input.targets;
  let entries = input.entries;
  let files = input.files ?? [];
  let payload: unknown;

  if (input.payload !== undefined) {
    const kind = kinds.find(kindId);

    if (kind === undefined) {
      throw new ContractError(
        'invalid_input',
        `Artifact kind "${kindId}" is not registered; a payload needs its kind's own materialization.`,
        { kind: kindId },
      );
    }

    payload = input.payload;

    if (kind.payload !== undefined) {
      const parsed = kind.payload.safeParse(input.payload);

      if (!parsed.success) {
        throw new ContractError(
          'invalid_input',
          `The payload is not a valid "${kindId}": ${parsed.error.issues
            .map((issue) => issue.message)
            .join('; ')}.`,
          { kind: kindId, payload: input.payload },
        );
      }

      payload = parsed.data;
    }

    if (kind.materialize !== undefined) {
      const materialized = await kind.materialize(
        { ...identity, payload },
        call,
      );

      entries = entries ?? checkedEntries(artifactId, materialized.entries);
      targets = targets ?? materialized.targets;
      files = input.files ?? materialized.files ?? [];
    } else if (entries === undefined) {
      throw new ContractError(
        'invalid_input',
        `Artifact kind "${kindId}" declares no materialization; a revision of it needs ready entries.`,
        { kind: kindId },
      );
    }
  }

  const resolvedEntries = entries ?? previous?.entries ?? [];

  return {
    targets: targets ?? previous?.targets ?? [],
    entries: resolvedEntries,
    files: verifiedFiles(artifactId, resolvedEntries, files),
    payload,
    source: input.source ?? previous?.source,
    path: input.path ?? previous?.path,
    entry: input.entry ?? previous?.entry,
  };
};

/** The stored revision of a resolved one, plus the per-call notes. */
const revisionOf = (
  resolved: ResolvedRevision,
  notes: { readonly notes?: string; readonly changeNote?: string },
  revision: number,
  createdAt: string,
): StoredArtifactRevision =>
  definedFields({
    revision,
    targets: resolved.targets,
    entries: resolved.entries,
    source: resolved.source,
    path: resolved.path,
    entry: resolved.entry,
    notes: notes.notes,
    changeNote: notes.changeNote,
    createdAt,
  });

/**
 * The scope the artifact's events are appended under: the Thread log sink
 * needs `projectId`, `threadId` and `promptId`. A prompt's call carries all
 * three; a window's call (an approval, an apply) carries the Project only, and
 * the event then lands in the log of the Thread and prompt that created the
 * artifact. Anything less is refused before a single write, as `events/v1`
 * would refuse the append with `invalid_scope`.
 */
const eventScopeOf = (
  call: Call,
  artifact?: Pick<StoredArtifact, 'threadId' | 'promptId'>,
): CallScope => {
  const scope = readRuntimeScope(call);
  const own = scope.threadId !== undefined && scope.promptId !== undefined;
  const threadId = own ? scope.threadId : artifact?.threadId;
  const promptId = own ? scope.promptId : artifact?.promptId;

  if (
    scope.projectId === undefined ||
    threadId === undefined ||
    promptId === undefined
  ) {
    throw new ContractError(
      'invalid_scope',
      'An artifact transition needs a call scoped to a Project, a Thread and a prompt.',
      { scope: { ...scope } },
    );
  }

  return { projectId: scope.projectId, threadId, promptId };
};

/** Parses an event body before any write, as `events/v1` would on append. */
const checkedEvent = <P extends Record<string, unknown>>(
  definition: EventDefinition,
  payload: P,
): P => {
  const parsed = definition.payload.safeParse(payload);

  if (!parsed.success) {
    throw new ContractError(
      'invalid_input',
      `Invalid ${definition.type} payload: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}.`,
      { type: definition.type },
    );
  }

  return payload;
};

/** Runs an undo step of a failed transition, keeping the original failure. */
const undo = async (step: () => Promise<void>): Promise<void> => {
  try {
    await step();
  } catch {
    // The transition already failed; its own error is the one that matters.
  }
};

const unknownArtifact = (artifactId: string): ContractError =>
  new ContractError('invalid_input', `Unknown artifact "${artifactId}".`, {
    artifactId,
  });

const unreadableArtifact = (artifactId: string): ContractError =>
  new ContractError(
    'unavailable',
    `The manifest of artifact "${artifactId}" cannot be read.`,
    { artifactId },
  );

/** The review policy settings as their schema reads them, defaults included. */
const policySettings = async (
  services: Services,
  call: Call,
): Promise<ArtifactReviewPolicySettings> =>
  artifactReviewPolicy.schema.parse(
    await services.use(SettingsV1).get(artifactReviewPolicy, call),
  );

/** The policy the calling Project runs. */
const policyOf = async (
  services: Services,
  call: Call,
  kind?: string,
): Promise<ArtifactReviewPolicyValue['policy']> =>
  reviewPolicyOf(
    await policySettings(services, call),
    readRuntimeScope(call).projectId,
    kind,
  );

/** Read and list answer the lease state as "nothing there", never a failure. */
const unlessUnleased = async <T>(
  task: () => Promise<T>,
  fallback: T,
): Promise<T> => {
  try {
    return await task();
  } catch (error) {
    if (isLeaseUnavailable(error)) return fallback;
    throw error;
  }
};

/** The `artifacts/v1` service, over the Project's lease and the kind registry. */
export const artifactsService = (kinds: ArtifactKindRegistryState) => {
  // One transition at a time per artifact of a Project.
  const queues = new Map<string, Promise<unknown>>();
  // The waits of `awaitApproval`, woken by an approval or a policy change.
  const waiters = new Set<{
    readonly key: string;
    readonly wake: () => void;
  }>();

  const keyOf = (call: Call, artifactId: string): string =>
    `${readRuntimeScope(call).projectId ?? ''}/${artifactId}`;

  const exclusive = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );

    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });

    return run;
  };

  const wake = (key?: string): void => {
    for (const waiter of [...waiters]) {
      if (key === undefined || waiter.key === key) waiter.wake();
    }
  };

  const loaded = async (
    services: Services,
    call: Call,
    artifactId: string,
  ): Promise<StoredArtifact> => {
    const found = await createArtifactStore(services, call).load(artifactId);

    if (found.status === 'missing') throw unknownArtifact(artifactId);
    if (found.status === 'unreadable') throw unreadableArtifact(artifactId);

    return found.artifact;
  };

  /** The record of one revision when it may reach the code, else undefined. */
  const approvalOf = async (
    services: Services,
    call: Call,
    artifactId: string,
    revision: number,
  ): Promise<
    | { readonly status: 'absent' }
    | { readonly status: 'open' | 'cleared'; readonly record: ArtifactRecord }
  > => {
    const found = await createArtifactStore(services, call).load(artifactId);

    if (found.status !== 'ok') return { status: 'absent' };

    const entry = revisionIn(found.artifact, revision);

    if (entry === undefined) return { status: 'absent' };

    const record = recordOf(found.artifact, entry);
    const cleared =
      entry.approved === true ||
      (await policyOf(services, call, found.artifact.kind)) !== 'request';

    return { status: cleared ? 'cleared' : 'open', record };
  };

  return defineService(ArtifactsV1, {
    create: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.create,
      execute: async (input, call, services): Promise<ArtifactRecord> => {
        const scope = eventScopeOf(call);
        const artifactId = input.artifactId ?? newArtifactId(input.title);

        if (!artifactIdPattern.test(artifactId)) {
          throw new ContractError(
            'invalid_input',
            `"${artifactId}" is not an artifact id.`,
            { artifactId },
          );
        }

        return await exclusive(keyOf(call, artifactId), async () => {
          const store = createArtifactStore(services, call);

          if ((await store.load(artifactId)).status !== 'missing') {
            throw new ContractError(
              'invalid_input',
              `Artifact "${artifactId}" already exists.`,
              { artifactId },
            );
          }

          const createdAt = new Date().toISOString();
          const resolved = await resolveRevision(
            input,
            { kind: input.kind, artifactId, revision: 1, title: input.title },
            undefined,
            kinds,
            call,
          );
          const entry = revisionOf(resolved, input, 1, createdAt);
          const artifact: StoredArtifact = definedFields({
            manifestVersion: 1,
            artifactId,
            kind: input.kind,
            title: input.title,
            createdAt,
            createdBy: call.caller.bundleId,
            threadId: scope.threadId,
            promptId: scope.promptId,
            revisions: [entry],
          });
          const payload = checkedEvent(
            artifactsCreatedEvent,
            definedFields({
              artifactId,
              revision: 1,
              kind: artifact.kind,
              title: artifact.title,
              targets: [...entry.targets],
              entries: [...entry.entries],
              source: entry.source,
              path: entry.path,
              entry: entry.entry,
              notes: entry.notes,
              payload: resolved.payload,
            }),
          );

          try {
            await store.writeRevision(artifactId, 1, resolved.files);
            await store.writeManifest(artifactId, artifact);
            await services
              .use(EventsV1, scope)
              .append(artifactsCreatedEvent, payload, call);
          } catch (error) {
            await undo(() => store.writeManifest(artifactId, undefined));
            throw error;
          }

          return recordOf(artifact, entry);
        });
      },
    }),
    revise: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.revise,
      execute: async (input, call, services): Promise<ArtifactRecord> =>
        exclusive(keyOf(call, input.artifactId), async () => {
          const store = createArtifactStore(services, call);
          const artifact = await loaded(services, call, input.artifactId);
          const scope = eventScopeOf(call, artifact);
          const previous = newestRevision(artifact);
          const revision = previous.revision + 1;
          const resolved = await resolveRevision(
            input,
            {
              kind: artifact.kind,
              artifactId: artifact.artifactId,
              revision,
              title: artifact.title,
            },
            previous,
            kinds,
            call,
          );
          const entry = revisionOf(
            resolved,
            input,
            revision,
            new Date().toISOString(),
          );
          const next: StoredArtifact = {
            ...artifact,
            revisions: [...artifact.revisions, entry],
          };
          const payload = checkedEvent(
            artifactsRevisedEvent,
            definedFields({
              artifactId: artifact.artifactId,
              revision,
              kind: artifact.kind,
              title: artifact.title,
              changeNote: input.changeNote,
              // The log is the durable truth: the revision's resolved anchors
              // and entries travel with the event, so replay rebuilds the
              // revision without the work copy.
              targets: [...entry.targets],
              entries: [...entry.entries],
              payload: resolved.payload,
            }),
          );

          try {
            await store.writeRevision(
              artifact.artifactId,
              revision,
              resolved.files,
            );
            await store.writeManifest(artifact.artifactId, next);
            await services
              .use(EventsV1, scope)
              .append(artifactsRevisedEvent, payload, call);
          } catch (error) {
            await undo(() =>
              store.writeManifest(artifact.artifactId, artifact),
            );
            await undo(() =>
              store.removeRevision(artifact.artifactId, revision),
            );
            throw error;
          }

          return recordOf(next, entry);
        }),
    }),
    read: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.read,
      execute: async (
        input,
        call,
        services,
      ): Promise<ArtifactRevisionRead | undefined> =>
        unlessUnleased(async () => {
          const store = createArtifactStore(services, call);
          const found = await store.load(input.artifactId);

          if (found.status !== 'ok') return undefined;

          const { artifact } = found;
          const entry =
            input.revision === undefined
              ? newestRevision(artifact)
              : revisionIn(artifact, input.revision);

          if (entry === undefined) return undefined;

          // The directories that may hold this revision's bytes: its own,
          // then each earlier one (an entry carried over unchanged), newest
          // first. The hash decides; the event is the durable truth, and an
          // entry whose bytes are gone reads without them.
          const revisions = artifact.revisions
            .map((candidate) => candidate.revision)
            .filter((candidate) => candidate <= entry.revision)
            .reverse();
          const entries: ArtifactReadEntry[] = [];

          for (const stored of entry.entries) {
            const bytes = await store.readEntry(
              artifact.artifactId,
              stored.path,
              stored.sha256,
              revisions,
            );

            entries.push(
              bytes === undefined
                ? { path: stored.path, sha256: stored.sha256 }
                : {
                    path: stored.path,
                    sha256: stored.sha256,
                    base64: Buffer.from(bytes).toString('base64'),
                  },
            );
          }

          return { ...recordOf(artifact, entry), entries };
        }, undefined),
    }),
    list: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.list,
      execute: async (
        input,
        call,
        services,
      ): Promise<readonly ArtifactRecord[]> =>
        unlessUnleased(async () => {
          const stored = await createArtifactStore(services, call).list();
          // The spec's reading: a call scoped to a Thread lists that Thread's.
          const threadId = input.threadId ?? readRuntimeScope(call).threadId;

          return stored
            .filter(
              (artifact) =>
                threadId === undefined || artifact.threadId === threadId,
            )
            .sort((left, right) =>
              left.createdAt === right.createdAt
                ? left.artifactId.localeCompare(right.artifactId)
                : left.createdAt.localeCompare(right.createdAt),
            )
            .map((artifact) => recordOf(artifact, newestRevision(artifact)));
        }, []),
    }),
    revisions: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.revisions,
      execute: async (
        input,
        call,
        services,
      ): Promise<readonly ArtifactRecord[]> =>
        unlessUnleased(async () => {
          const found = await createArtifactStore(services, call).load(
            input.artifactId,
          );

          if (found.status !== 'ok') return [];

          return found.artifact.revisions.map((entry) =>
            recordOf(found.artifact, entry),
          );
        }, []),
    }),
    approve: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.approve,
      execute: async (
        input,
        call,
        services,
      ): Promise<ArtifactRecord | undefined> =>
        exclusive(keyOf(call, input.artifactId), async () => {
          const store = createArtifactStore(services, call);
          const found = await store.load(input.artifactId);

          if (found.status === 'unreadable') {
            throw unreadableArtifact(input.artifactId);
          }

          if (found.status === 'missing') return undefined;

          const { artifact } = found;
          const entry = revisionIn(artifact, input.revision);

          if (entry === undefined) return undefined;

          // No approval exists outside `request`, and one approval per
          // revision: either way nothing is recorded.
          if (
            entry.approved === true ||
            (await policyOf(services, call, artifact.kind)) !== 'request'
          ) {
            return recordOf(artifact, entry);
          }

          const scope = eventScopeOf(call, artifact);
          const approved: StoredArtifactRevision = { ...entry, approved: true };
          const next: StoredArtifact = {
            ...artifact,
            revisions: artifact.revisions.map((candidate) =>
              candidate.revision === input.revision ? approved : candidate,
            ),
          };
          const payload = checkedEvent(artifactsApprovedEvent, {
            artifactId: artifact.artifactId,
            revision: input.revision,
            scope: artifactApprovalScope,
          });

          try {
            await store.writeManifest(artifact.artifactId, next);
            await services
              .use(EventsV1, scope)
              .append(artifactsApprovedEvent, payload, call);
          } catch (error) {
            await undo(() =>
              store.writeManifest(artifact.artifactId, artifact),
            );
            throw error;
          }

          wake(keyOf(call, artifact.artifactId));

          return recordOf(next, approved);
        }),
    }),
    awaitApproval: defineMethod({
      ...artifactsMethods.awaitApproval,
      execute: async (
        input,
        call,
        services,
      ): Promise<ArtifactRecord | undefined> => {
        const key = keyOf(call, input.artifactId);
        const deadline =
          input.timeoutMs === undefined
            ? undefined
            : Date.now() + input.timeoutMs;

        for (;;) {
          // Listen before reading, so an approval between the two still wakes.
          let woken: () => void = () => undefined;
          const signal = new Promise<void>((resolve) => {
            woken = resolve;
          });
          const waiter = { key, wake: () => woken() };

          waiters.add(waiter);

          try {
            const state = await approvalOf(
              services,
              call,
              input.artifactId,
              input.revision,
            );

            if (state.status === 'absent') return undefined;
            if (state.status === 'cleared') return state.record;

            const left =
              deadline === undefined ? undefined : deadline - Date.now();

            if (left !== undefined && left <= 0) return state.record;

            let timer: ReturnType<typeof setTimeout> | undefined;
            let onAbort: (() => void) | undefined;

            try {
              await Promise.race([
                signal,
                new Promise<void>((resolve) => {
                  if (left !== undefined) timer = setTimeout(resolve, left);
                }),
                new Promise<never>((_, reject) => {
                  onAbort = () => reject(call.signal.reason);
                  if (call.signal.aborted) onAbort();
                  else call.signal.addEventListener('abort', onAbort);
                }),
              ]);
            } finally {
              if (timer !== undefined) clearTimeout(timer);
              if (onAbort !== undefined) {
                call.signal.removeEventListener('abort', onAbort);
              }
            }
          } finally {
            waiters.delete(waiter);
          }
        }
      },
    }),
    policy: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.policy,
      execute: async (_input: readonly [], call, services) => {
        const settings = await policySettings(services, call);

        return {
          policy: reviewPolicyOf(settings, readRuntimeScope(call).projectId),
          exemptKinds: settings.exemptKinds,
        } satisfies ArtifactReviewPolicyValue;
      },
    }),
    setPolicy: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.setPolicy,
      execute: async (
        input: ArtifactReviewPolicyValue,
        call,
        services,
      ): Promise<ArtifactReviewPolicyValue> => {
        const projectId = readRuntimeScope(call).projectId;
        const settings = services.use(SettingsV1);

        // One value holds every Project's choice: write on the revision just
        // read, and read again when another write got there first.
        for (let attempt = 0; ; attempt += 1) {
          const entry = await settings.entry(artifactReviewPolicy, call);
          const current = artifactReviewPolicy.schema.parse(entry.value);
          const next: ArtifactReviewPolicySettings =
            projectId === undefined
              ? { ...current, policy: input.policy }
              : {
                  ...current,
                  projects: { ...current.projects, [projectId]: input.policy },
                };

          try {
            await settings.set(
              artifactReviewPolicy,
              next,
              { expectedRevision: entry.revision },
              call,
            );
            break;
          } catch (error) {
            if (
              attempt < 2 &&
              error instanceof ContractError &&
              error.code === 'settings_conflict'
            ) {
              continue;
            }
            throw error;
          }
        }

        // A wait for an approval may be over now that the gate moved.
        wake();

        return { policy: input.policy } satisfies ArtifactReviewPolicyValue;
      },
    }),
    apply: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.apply,
      execute: async (
        input,
        call,
        services,
      ): Promise<ArtifactRecord | undefined> =>
        exclusive(keyOf(call, input.artifactId), async () => {
          const found = await createArtifactStore(services, call).load(
            input.artifactId,
          );

          if (found.status === 'unreadable') {
            throw unreadableArtifact(input.artifactId);
          }

          if (found.status === 'missing') return undefined;

          const { artifact } = found;
          const entry = revisionIn(artifact, input.revision);

          if (entry === undefined) return undefined;

          if (
            entry.approved !== true &&
            (await policyOf(services, call, artifact.kind)) === 'request'
          ) {
            throw new ContractError(
              'invalid_input',
              `Revision ${input.revision} of artifact "${artifact.artifactId}" is not approved; the Project's review policy asks for an approval before the code is written.`,
              {
                artifactId: artifact.artifactId,
                revision: input.revision,
                reason: 'not_approved',
              },
            );
          }

          const scope = eventScopeOf(call, artifact);

          await services.use(EventsV1, scope).append(
            artifactsAppliedEvent,
            checkedEvent(artifactsAppliedEvent, {
              artifactId: artifact.artifactId,
              revision: input.revision,
              files: [...input.files],
            }),
            call,
          );

          return recordOf(artifact, entry);
        }),
    }),
  });
};

export { DOT_DORIC_IGNORE };
