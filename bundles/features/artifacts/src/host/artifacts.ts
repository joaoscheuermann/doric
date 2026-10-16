// `artifacts/v1` (host): the registry of the Project's reviewable deliverables.
//
// A revision is immutable: `revise` appends, never rewrites, so the node and
// the comments of an earlier revision stay valid. The work copy lives in the
// Project's sandbox (`store.ts`) and every transition publishes one durable
// event through `events/v1`, which appends to the Thread log the runtime
// already owns. The registry never interprets the payload of a kind: the
// anchors and the ready entries are the caller's, and a payload is the kind's
// own, validated by the schema the kind registered and materialized by the
// provider the kind declared. The bytes of a revision reach the work copy
// once — through `files` or the kind's materialization — always verified
// against the entry's hash, and never inside an event.

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type Events,
  EventsV1,
  SettingsV1,
} from 'bundle/contracts';
import { readRuntimeScope } from 'runtime/contracts';

import {
  type ArtifactEntry,
  type ArtifactFile,
  type ArtifactMaterialization,
  type ArtifactReadEntry,
  type ArtifactRecord,
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
} from '../contracts/index.js';
import { artifactIdPattern, newArtifactId } from './ids.js';
import type { ArtifactKindRegistryState } from './kinds.js';
import {
  createArtifactStore,
  DOT_DORIC_IGNORE,
  type StoredArtifact,
  type StoredArtifactRevision,
  sha256Of,
} from './store.js';

const hasRevision = (artifact: StoredArtifact, revision: number): boolean =>
  artifact.revisions.some((entry) => entry.revision === revision);

/**
 * A record or a payload without the keys whose value is `undefined`: an absent
 * optional field stays absent, in the answer and in the durable event body.
 */
const definedFields = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;

const newestRevision = (artifact: StoredArtifact): StoredArtifactRevision => {
  const newest = artifact.revisions.at(-1);

  if (newest === undefined) {
    throw new ContractError(
      'internal',
      `Artifact "${artifact.artifactId}" has no revision.`,
      {
        artifactId: artifact.artifactId,
      },
    );
  }

  return newest;
};

/** The artifact as one of its revisions reads, which is what every caller sees. */
const recordOf = (
  artifact: StoredArtifact,
  revision: number,
): ArtifactRecord => {
  const entry = artifact.revisions.find(
    (candidate) => candidate.revision === revision,
  );

  if (entry === undefined) {
    throw new ContractError(
      'internal',
      `Artifact "${artifact.artifactId}" has no revision ${revision}.`,
      { artifactId: artifact.artifactId, revision },
    );
  }

  return definedFields({
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
    state: artifact.state,
    createdAt: artifact.createdAt,
    createdBy: artifact.createdBy,
  });
};

/** One entry as `read` serves it: the hash, and the bytes when they hold. */
const readEntryOf = async (
  entry: ArtifactEntry,
  read: (path: string) => Promise<string | undefined>,
): Promise<ArtifactReadEntry> => {
  const content = await read(entry.path);

  // The event is the durable truth; the work copy serves bytes only when they
  // still hash to the entry. A derived kind (a `preview`) reconstructs its
  // form elsewhere, so its bytes may be gone — the entry still names what
  // existed.
  if (content === undefined || sha256Of(content) !== entry.sha256) {
    return { path: entry.path, sha256: entry.sha256 };
  }

  return {
    path: entry.path,
    sha256: entry.sha256,
    base64: Buffer.from(content, 'utf8').toString('base64'),
  };
};

/** What a revision keeps of the caller's declaration; absent stays absent. */
interface RevisionInput {
  readonly targets?: readonly ArtifactTarget[];
  readonly entries?: readonly ArtifactEntry[];
  readonly files?: readonly ArtifactFile[];
  readonly payload?: unknown;
  readonly source?: ArtifactRecord['source'];
  readonly path?: string;
  readonly entry?: string;
  readonly notes?: string;
  readonly changeNote?: string;
}

/** One revision fully resolved: anchors, entries, bytes and payload place. */
interface ResolvedRevision {
  readonly targets: readonly ArtifactTarget[];
  readonly entries: readonly ArtifactEntry[];
  readonly files: readonly ArtifactFile[];
  readonly source?: ArtifactRecord['source'];
  readonly path?: string;
  readonly entry?: string;
}

/**
 * Resolves one revision's anchors, entries and bytes. Ready entries win; a
 * payload is the kind's own — validated against the schema the kind
 * registered and materialized by the provider it declared — and fills in the
 * entries (and the bytes) the caller did not give. Absent anchors, entries
 * and payload places carry over from the previous revision, as `revise`
 * promises. The bytes are verified against the entries they name, so the
 * hashes of the durable event always verify the work copy.
 */
const resolveRevision = async (
  input: RevisionInput,
  kindId: string,
  artifactId: string,
  revision: number,
  title: string,
  previous: ArtifactRecord | undefined,
  kinds: ArtifactKindRegistryState,
  call: Call,
): Promise<ResolvedRevision> => {
  let targets = input.targets;
  let entries = input.entries;
  let files = input.files ?? [];

  if (input.payload !== undefined) {
    const kind = kinds.find(kindId);

    if (kind === undefined) {
      throw new ContractError(
        'invalid_input',
        `Artifact kind "${kindId}" is not registered; a payload needs its kind's own materialization.`,
        { kind: kindId },
      );
    }

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
    }

    if (kind.materialize !== undefined) {
      const materialized: ArtifactMaterialization = await kind.materialize(
        { payload: input.payload, artifactId, revision, title },
        call,
      );

      entries = entries ?? materialized.entries;
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

  return {
    targets: targets ?? previous?.targets ?? [],
    entries: entries ?? previous?.entries ?? [],
    files,
    source: input.source ?? previous?.source,
    path: input.path ?? previous?.path,
    entry: input.entry ?? previous?.entry,
  };
};

/** Writes one revision's bytes into the work copy, verifying their hashes. */
const writeFiles = async (
  artifactId: string,
  entries: readonly ArtifactEntry[],
  files: readonly ArtifactFile[],
  writeEntry: (path: string, content: string) => Promise<void>,
): Promise<void> => {
  for (const file of files) {
    const entry = entries.find((candidate) => candidate.path === file.path);

    if (entry === undefined) {
      throw new ContractError(
        'invalid_input',
        `File "${file.path}" names no entry of the revision.`,
        { artifactId, path: file.path },
      );
    }

    const content = Buffer.from(file.base64, 'base64').toString('utf8');

    // The lease's `writeFile` carries text; the boundary is honest for the
    // payloads the kinds of this delivery write (markup, documents).
    if (sha256Of(content) !== entry.sha256) {
      throw new ContractError(
        'invalid_input',
        `File "${file.path}" does not hash to the entry it names.`,
        { artifactId, path: file.path, sha256: entry.sha256 },
      );
    }

    await writeEntry(file.path, content);
  }
};

/**
 * What the caller declared, as the revision keeps it; the resolved anchors,
 * entries and payload place plus the per-call notes, absent stays absent.
 */
const revisionOf = (
  resolved: ResolvedRevision,
  notes: { readonly notes?: string; readonly changeNote?: string },
  revision: number,
  createdAt: string,
): StoredArtifactRevision => ({
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

const appendCreated = async (
  events: Events,
  artifact: StoredArtifact,
  entry: StoredArtifactRevision,
  call: Call,
): Promise<void> => {
  await events.append(
    artifactsCreatedEvent,
    definedFields({
      artifactId: artifact.artifactId,
      revision: entry.revision,
      kind: artifact.kind,
      title: artifact.title,
      targets: [...entry.targets],
      entries: [...entry.entries],
      source: entry.source,
      path: entry.path,
      entry: entry.entry,
      notes: entry.notes,
    }),
    call,
  );
};

/** The `artifacts/v1` service, over the Project's lease and the kind registry. */
export const artifactsService = (kinds: ArtifactKindRegistryState) =>
  defineService(ArtifactsV1, {
    create: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.create,
      execute: async (input, call, services): Promise<ArtifactRecord> => {
        const store = createArtifactStore(services, call);
        const artifactId = input.artifactId ?? newArtifactId(input.title);

        if (!artifactIdPattern.test(artifactId)) {
          throw new ContractError(
            'invalid_input',
            `"${artifactId}" is not an artifact id.`,
            {
              artifactId,
            },
          );
        }

        if ((await store.read(artifactId)) !== undefined) {
          throw new ContractError(
            'invalid_input',
            `Artifact "${artifactId}" already exists.`,
            {
              artifactId,
            },
          );
        }

        const scope = readRuntimeScope(call);
        const createdAt = new Date().toISOString();
        const resolved = await resolveRevision(
          input,
          input.kind,
          artifactId,
          1,
          input.title,
          undefined,
          kinds,
          call,
        );

        await writeFiles(
          artifactId,
          resolved.entries,
          resolved.files,
          (path, content) => store.writeEntry(artifactId, path, content),
        );

        const entry = revisionOf(resolved, input, 1, createdAt);
        const artifact: StoredArtifact = {
          manifestVersion: 1,
          artifactId,
          kind: input.kind,
          title: input.title,
          state: 'open',
          createdAt,
          createdBy: call.caller.bundleId,
          threadId: scope.threadId,
          promptId: scope.promptId,
          revisions: [entry],
        };

        await store.write(artifact);
        await appendCreated(services.use(EventsV1), artifact, entry, call);

        return recordOf(artifact, 1);
      },
    }),
    revise: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.revise,
      execute: async (input, call, services): Promise<ArtifactRecord> => {
        const store = createArtifactStore(services, call);
        const artifact = await store.read(input.artifactId);

        if (artifact === undefined) {
          throw new ContractError(
            'invalid_input',
            `Unknown artifact "${input.artifactId}".`,
            {
              artifactId: input.artifactId,
            },
          );
        }

        const previous = recordOf(artifact, newestRevision(artifact).revision);
        const revision = previous.revision + 1;
        const resolved = await resolveRevision(
          input,
          artifact.kind,
          input.artifactId,
          revision,
          artifact.title,
          previous,
          kinds,
          call,
        );

        await writeFiles(
          input.artifactId,
          resolved.entries,
          resolved.files,
          (path, content) => store.writeEntry(input.artifactId, path, content),
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

        await store.write(next);
        await services.use(EventsV1).append(
          artifactsRevisedEvent,
          definedFields({
            artifactId: next.artifactId,
            revision,
            changeNote: input.changeNote,
            // The log is the durable truth: the revision's resolved anchors
            // and entries travel with the event, so replay rebuilds the
            // revision without the work copy.
            targets: [...entry.targets],
            entries: [...entry.entries],
          }),
          call,
        );

        return recordOf(next, revision);
      },
    }),
    read: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.read,
      execute: async (
        input,
        call,
        services,
      ): Promise<ArtifactRevisionRead | undefined> => {
        const store = createArtifactStore(services, call);
        const artifact = await store.read(input.artifactId);

        if (artifact === undefined) return undefined;

        const revision = input.revision ?? newestRevision(artifact).revision;

        if (!hasRevision(artifact, revision)) return undefined;

        const record = recordOf(artifact, revision);
        const entry = artifact.revisions.find(
          (candidate) => candidate.revision === revision,
        ) as StoredArtifactRevision;

        // `read` is the registry's `doric.catalog/v1.artifact`: the entry's
        // hash plus the bytes, base64, when the work copy still holds them.
        const entries: ArtifactReadEntry[] = [];
        for (const stored of entry.entries) {
          entries.push(
            await readEntryOf(stored, (path) =>
              store.readEntry(input.artifactId, path),
            ),
          );
        }

        return { ...record, entries };
      },
    }),
    list: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.list,
      execute: async (
        input,
        call,
        services,
      ): Promise<readonly ArtifactRecord[]> => {
        const stored = await createArtifactStore(services, call).list();

        return stored
          .filter(
            (artifact) =>
              input.threadId === undefined ||
              artifact.threadId === input.threadId,
          )
          .sort((left, right) =>
            left.createdAt === right.createdAt
              ? left.artifactId.localeCompare(right.artifactId)
              : left.createdAt.localeCompare(right.createdAt),
          )
          .map((artifact) =>
            recordOf(artifact, newestRevision(artifact).revision),
          );
      },
    }),
    approve: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.approve,
      execute: async (
        input,
        call,
        services,
      ): Promise<ArtifactRecord | undefined> => {
        const store = createArtifactStore(services, call);
        const artifact = await store.read(input.artifactId);

        if (artifact === undefined || !hasRevision(artifact, input.revision))
          return undefined;

        // Idempotent where the gesture exists: an approval already in force for
        // this revision records nothing a second time.
        if (
          artifact.state === 'approved' &&
          artifact.approvedRevision === input.revision
        ) {
          return recordOf(artifact, input.revision);
        }

        await services.use(EventsV1).append(
          artifactsApprovedEvent,
          {
            artifactId: input.artifactId,
            revision: input.revision,
            scope: artifactApprovalScope,
          },
          call,
        );

        // Only `request` gates the write back into the Project's code, so only
        // it moves the artifact to `approved`; `proceed` records the gesture
        // and keeps going.
        const { policy } = await services
          .use(SettingsV1)
          .get(artifactReviewPolicy, call);

        if (policy !== 'request') return recordOf(artifact, input.revision);

        const next: StoredArtifact = {
          ...artifact,
          state: 'approved',
          approvedRevision: input.revision,
        };

        await store.write(next);

        return recordOf(next, input.revision);
      },
    }),
    policy: defineMethod({
      expose: 'desktop',
      ...artifactsMethods.policy,
      execute: async (_input: readonly [], call, services) => {
        const { policy } = await services
          .use(SettingsV1)
          .get(artifactReviewPolicy, call);

        return { policy } satisfies ArtifactReviewPolicyValue;
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
        await services
          .use(SettingsV1)
          .set(artifactReviewPolicy, { policy: input.policy }, undefined, call);

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
      ): Promise<ArtifactRecord | undefined> => {
        const artifact = await createArtifactStore(services, call).read(
          input.artifactId,
        );

        if (artifact === undefined || !hasRevision(artifact, input.revision))
          return undefined;

        await services.use(EventsV1).append(
          artifactsAppliedEvent,
          {
            artifactId: input.artifactId,
            revision: input.revision,
            files: [...input.files],
          },
          call,
        );

        return recordOf(artifact, input.revision);
      },
    }),
  });

export { DOT_DORIC_IGNORE };
