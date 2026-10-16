// Dev-only: the `artifacts/v1` registry and the `papercraft.previews/v1`
// materialisation, in memory, over the directory the real host uses.
//
// The record, the payload directory, the manifest and the events follow
// `docs/architecture/bundles/artifacts.md` and the real registry's shapes
// (`bundles/features/artifacts/src/host/store.ts`), which this file must not
// drift from — the audit that found the drift is why it is aligned:
//
//  - `/workspace/.doric/artifacts/<artifactId>/` holds the newest payload and
//    `artifact.json`, the index of the working copy, in exactly the real
//    bundle's `StoredArtifact` shape — `manifestVersion`, identity, `state`,
//    `approvedRevision`, provenance and one entry per revision, each with its
//    anchors and entries;
//  - a `preview` revision is materialised by the `papercraft` bundle's own
//    build function (see `papercraft.mjs`), never by markup written here;
//  - every change appends its durable event to the Thread log, so the
//    conversation and the canvas see the same truth — `artifacts.created/v1`
//    carries the revision's anchors and entries, `artifacts.revised/v1` the
//    next revision's resolved ones, and neither ever carries bytes.
//
// What the fake host does not have, it says instead of faking: no lease, no
// settings service, no type registry. `artifact.kind/v1` and `settings/v1` are
// the bundles' contracts, and the desktop reads the review policy through
// `artifacts/v1.policy` (an explicit `--review-policy` flag here) rather than
// asking the fake host to invent a settings store.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DevHostError } from './bundles.mjs';
import { buildPreview } from './papercraft.mjs';

/** The artifact id a title slug leaves when nothing usable is left. */
const FALLBACK_SLUG = 'artifact';

const REVISION_SCOPE = 'revision';

/** A lowercase slug of the title plus a short random suffix (`checkout-7f3a`). */
export const artifactIdOf = (title) => {
  const slug = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return `${slug.length === 0 ? FALLBACK_SLUG : slug}-${randomBytes(2).toString('hex')}`;
};

const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);

/**
 * The registry. `origin` names the seeded Project and Thread every event of
 * the fake host belongs to; the prompt is the Thread's current one, so a
 * comment or an artifact event lands beside the turn it belongs to.
 */
export const createArtifacts = ({
  workspaceRoot,
  defaults,
  threads,
  papercraft,
  policy,
  log,
  now = () => new Date().toISOString(),
}) => {
  /** artifactId → the manifest, in the real bundle's `StoredArtifact` shape. */
  const manifests = new Map();
  /** artifactId → revision → `{ files, markup }`, the dev host's work copy. */
  const payloads = new Map();
  /** The artifact the scope is working on: what `papercraft.previews/v1.build` resolves. */
  let current;

  const scopeOf = () => ({
    projectId: defaults.projectId,
    threadId: defaults.threadId,
    promptId: threads.promptIdOf(defaults.threadId),
  });

  const append = (type, event) =>
    threads.append({ ...scopeOf(), threadId: defaults.threadId, type, event });

  const dirOf = (artifactId) =>
    join(workspaceRoot, '.doric/artifacts', artifactId);

  /** The dev host's payload of one revision: its entries and markup. */
  const payloadOf = (artifactId, revision) =>
    payloads.get(artifactId)?.get(revision);

  /**
   * Materialises one revision of a `preview` through the papercraft build,
   * exactly as the real bundle's kind provider does. A preview whose payload
   * the scope never wrote (the desktop can create an artifact without writing
   * files) is recorded with no markup, and the log says so: it is not filled in
   * with content invented here.
   */
  const materialise = async ({
    artifactId,
    revision,
    kind,
    source,
    path,
    entry,
  }) => {
    const built = { files: [], markup: undefined };

    if (kind !== 'preview') return built;

    if (papercraft === undefined) {
      log.note(
        `artifact ${artifactId} revision ${revision}: a preview without a papercraft host part is recorded without markup`,
      );

      return built;
    }

    try {
      const result = await buildPreview({
        papercraft,
        workspaceRoot,
        dir: dirOf(artifactId),
        path: path ?? 'index.html',
        entry,
        source: source ?? 'html',
        artifactId,
        revision,
        log,
      });

      if (result.markup === undefined) {
        log.note(
          `artifact ${artifactId} revision ${revision}: the papercraft build produced no markup`,
        );
      }

      return result;
    } catch (error) {
      log.note(
        `artifact ${artifactId} revision ${revision}: the papercraft build failed (${messageOf(error)})`,
      );

      return built;
    }
  };

  const store = (artifactId, revision, built) => {
    const revisions = payloads.get(artifactId) ?? new Map();

    revisions.set(revision, built);
    payloads.set(artifactId, revisions);
  };

  /**
   * The manifest as the real bundle's store writes it, in `StoredArtifact`'s
   * shape: manifest version, identity, review state, provenance and one entry
   * per revision — each with its anchors and entries, never the bytes.
   */
  const manifestOf = (manifest) => ({
    manifestVersion: 1,
    artifactId: manifest.artifactId,
    kind: manifest.kind,
    title: manifest.title,
    state: manifest.state,
    ...(manifest.approvedRevision === undefined
      ? {}
      : { approvedRevision: manifest.approvedRevision }),
    createdAt: manifest.createdAt,
    ...(manifest.createdBy === undefined
      ? {}
      : { createdBy: manifest.createdBy }),
    threadId: manifest.threadId,
    promptId: manifest.promptId,
    revisions: manifest.revisions.map((revision) => ({
      revision: revision.revision,
      targets: revision.targets,
      entries: revision.entries,
      ...(revision.source === undefined ? {} : { source: revision.source }),
      ...(revision.path === undefined ? {} : { path: revision.path }),
      ...(revision.entry === undefined ? {} : { entry: revision.entry }),
      ...(revision.notes === undefined ? {} : { notes: revision.notes }),
      ...(revision.changeNote === undefined
        ? {}
        : { changeNote: revision.changeNote }),
      createdAt: revision.createdAt,
    })),
  });

  /**
   * The wire record of one revision, in the real bundle's `ArtifactRecord`
   * shape — the manifest's identity and provenance, the revision's anchors,
   * entries and payload place, and the review state. `revision` defaults to
   * the newest, exactly as `artifacts/v1.read` does.
   */
  const recordOf = (manifest, revision) => {
    const asked = revision ?? manifest.revisions.length;
    const stored = manifest.revisions.find((entry) => entry.revision === asked);

    if (stored === undefined) return undefined;

    return {
      artifactId: manifest.artifactId,
      kind: manifest.kind,
      title: manifest.title,
      revision: asked,
      revisions: manifest.revisions.length,
      targets: stored.targets,
      entries: stored.entries,
      ...(stored.source === undefined ? {} : { source: stored.source }),
      ...(stored.path === undefined ? {} : { path: stored.path }),
      ...(stored.entry === undefined ? {} : { entry: stored.entry }),
      ...(stored.notes === undefined ? {} : { notes: stored.notes }),
      ...(stored.changeNote === undefined
        ? {}
        : { changeNote: stored.changeNote }),
      state: manifest.state,
      createdAt: manifest.createdAt,
      ...(manifest.createdBy === undefined
        ? {}
        : { createdBy: manifest.createdBy }),
    };
  };

  /**
   * Writes the working copy: the payload of the newest revision beside
   * `artifact.json`, the index of the working copy, in exactly the shape the
   * real bundle's store writes. `.doric/` is born Git-ignored, as the real
   * store guarantees it.
   */
  const writeManifest = async (artifactId) => {
    const manifest = manifests.get(artifactId);
    const dir = dirOf(artifactId);

    await mkdir(join(workspaceRoot, '.doric'), { recursive: true });

    const ignore = join(workspaceRoot, '.doric', '.gitignore');

    if (
      await readFile(ignore, 'utf8').then(
        () => false,
        () => true,
      )
    ) {
      await writeFile(ignore, '*\n', 'utf8');
    }

    const built = payloadOf(artifactId, manifest.revisions.at(-1).revision);

    if (built?.markup !== undefined) {
      for (const file of built.files) {
        if (file.path === 'index.html') {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, file.path), built.markup, 'utf8');
        }
      }
    }

    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'artifact.json'),
      `${JSON.stringify(manifestOf(manifest), null, 2)}\n`,
      'utf8',
    );
  };

  /**
   * `artifacts/v1.create`: a new artifact, its first revision, its event. The
   * preview materialisation is the dev host's own — a desktop that created an
   * artifact without a source would answer the same nothing the log says.
   */
  const create = async (input = {}) => {
    const {
      artifactId,
      kind,
      title,
      targets,
      source,
      path,
      entry,
      notes,
      createdBy,
    } = input;
    const id = artifactId ?? artifactIdOf(title);

    if (typeof id !== 'string' || id.length === 0) {
      throw new DevHostError(
        'invalid_input',
        'An artifact needs a title or an artifactId.',
      );
    }

    if (manifests.has(id)) {
      throw new DevHostError(
        'invalid_input',
        `Artifact "${id}" already exists.`,
      );
    }

    const createdAt = now();
    const scope = scopeOf();
    const manifest = {
      artifactId: id,
      kind: String(kind ?? 'preview'),
      title: String(title ?? id),
      state: 'open',
      createdAt,
      ...(createdBy === undefined ? {} : { createdBy: String(createdBy) }),
      threadId: scope.threadId,
      promptId: scope.promptId,
      revisions: [],
    };

    const built = await materialise({
      artifactId: id,
      revision: 1,
      kind: manifest.kind,
      source,
      path,
      entry,
    });

    manifests.set(id, manifest);
    current = id;
    store(id, 1, built);

    manifest.revisions.push({
      revision: 1,
      targets: Array.isArray(targets) ? targets : [],
      entries: built.files,
      ...(source === undefined ? {} : { source }),
      ...(path === undefined ? {} : { path }),
      ...(entry === undefined ? {} : { entry }),
      ...(notes === undefined ? {} : { notes }),
      createdAt,
    });

    await writeManifest(id);

    append('artifacts.created/v1', {
      type: 'artifacts.created/v1',
      artifactId: id,
      revision: 1,
      kind: manifest.kind,
      title: manifest.title,
      targets: manifest.revisions[0].targets,
      entries: manifest.revisions[0].entries,
      ...(source === undefined ? {} : { source }),
      ...(path === undefined ? {} : { path }),
      ...(entry === undefined ? {} : { entry }),
      ...(notes === undefined ? {} : { notes }),
    });

    return recordOf(manifest, 1);
  };

  /** `artifacts/v1.revise`: the next revision of an existing artifact. */
  const revise = async (input = {}) => {
    const { artifactId, changeNote, targets, path, source, entry, notes } =
      input;
    const manifest = manifests.get(artifactId);

    if (manifest === undefined) return undefined;

    const previous = manifest.revisions.at(-1);
    const revision = previous.revision + 1;
    const carried = {
      source: source ?? previous.source,
      path: path ?? previous.path,
      entry: entry ?? previous.entry,
    };

    const built = await materialise({
      artifactId,
      revision,
      kind: manifest.kind,
      ...carried,
    });

    current = artifactId;
    store(artifactId, revision, built);

    manifest.revisions.push({
      revision,
      targets: Array.isArray(targets) ? targets : previous.targets,
      entries: built.files.length > 0 ? built.files : previous.entries,
      ...carried,
      ...(notes === undefined ? {} : { notes }),
      ...(changeNote === undefined ? {} : { changeNote }),
      createdAt: now(),
    });

    await writeManifest(artifactId);

    append('artifacts.revised/v1', {
      type: 'artifacts.revised/v1',
      artifactId,
      revision,
      ...(changeNote === undefined ? {} : { changeNote }),
      targets: manifest.revisions.at(-1).targets,
      entries: manifest.revisions.at(-1).entries,
    });

    return recordOf(manifest, revision);
  };

  /**
   * `artifacts/v1.read`: the record of one revision with the bytes of its
   * entries, base64 — the mold of `doric.catalog/v1.artifact`. The dev host
   * holds the payload in memory; the real registry reads the work copy.
   */
  const read = (input = {}) => {
    const manifest = manifests.get(input.artifactId);

    if (manifest === undefined) return undefined;

    const revision = input.revision ?? manifest.revisions.length;

    if (revision < 1 || revision > manifest.revisions.length) return undefined;

    const record = recordOf(manifest, revision);
    const built = payloadOf(input.artifactId, revision);

    return {
      ...record,
      entries: record.entries.map((file) => ({
        ...file,
        ...(built?.markup !== undefined && file.path === 'index.html'
          ? {
              base64: Buffer.from(built.markup, 'utf8').toString('base64'),
            }
          : {}),
      })),
    };
  };

  /** `artifacts/v1.list`: every artifact of a Thread, newest first. */
  const list = (input = {}) => {
    const { threadId } = input;

    return [...manifests.values()]
      .filter(
        (manifest) => threadId === undefined || manifest.threadId === threadId,
      )
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
      .map((manifest) => recordOf(manifest, manifest.revisions.length));
  };

  /**
   * `artifacts/v1.approve`: records the approval once, and moves the
   * revision's state only under the `request` policy — as the real registry
   * does, over the manifest's own `state` and `approvedRevision`. A second
   * approval of the same revision writes nothing.
   */
  const approve = (input = {}) => {
    const { artifactId, revision } = input;
    const manifest = manifests.get(artifactId);

    if (manifest === undefined) return undefined;

    const asked = revision ?? manifest.revisions.length;

    if (asked < 1 || asked > manifest.revisions.length) return undefined;

    if (manifest.state === 'approved' && manifest.approvedRevision === asked) {
      return recordOf(manifest, asked);
    }

    append('artifacts.approved/v1', {
      type: 'artifacts.approved/v1',
      artifactId,
      revision: asked,
      scope: REVISION_SCOPE,
    });

    if (policy === 'request') {
      manifest.state = 'approved';
      manifest.approvedRevision = asked;
    } else {
      log.note(
        `approve(${artifactId}@${asked}) under the "proceed" policy: the event is recorded and the revision stays open`,
      );
    }

    return recordOf(manifest, asked);
  };

  /** `artifacts/v1.policy`: the review policy the canvas bar reads. */
  const policyOf = () => ({ policy });

  /**
   * `artifacts/v1.apply`: records that a revision's files reached the code.
   * The dev host has no code-writing step, so the event is all it can honestly
   * write; the canvas never calls it because nothing there applied anything.
   */
  const apply = (input = {}) => {
    const { artifactId, revision, files } = input;
    const manifest = manifests.get(artifactId);

    if (manifest === undefined) return undefined;

    const asked = revision ?? manifest.revisions.length;

    if (asked < 1 || asked > manifest.revisions.length) return undefined;

    append('artifacts.applied/v1', {
      type: 'artifacts.applied/v1',
      artifactId,
      revision: asked,
      files: Array.isArray(files) ? files : [],
    });

    log.note(
      `apply(${artifactId}@${asked}) is recorded on the fake host; nothing writes the files it names`,
    );

    return recordOf(manifest, asked);
  };

  /** The artifact the scope is working on: what a bare `build` resolves. */
  const artifactOf = (artifactId) => {
    const id = artifactId ?? current;

    if (id === undefined || !manifests.has(id)) {
      throw new DevHostError(
        'invalid_input',
        'papercraft.previews/v1.build needs an artifact to build into: create one first.',
      );
    }

    return id;
  };

  /** `papercraft.previews/v1.build`: materialises the payload in the artifact directory. */
  const build = async (input = {}) => {
    const id = artifactOf(input.artifactId);
    const manifest = manifests.get(id);
    const revision = manifest.revisions.length;

    if (papercraft === undefined) {
      throw new DevHostError(
        'unavailable',
        'No papercraft host part is built: the fake host cannot materialise a preview.',
      );
    }

    const built = await buildPreview({
      papercraft,
      workspaceRoot,
      dir: dirOf(id),
      path: input.path ?? manifest.revisions.at(-1).path ?? 'index.html',
      entry: input.entry ?? manifest.revisions.at(-1).entry,
      source: input.source ?? manifest.revisions.at(-1).source ?? 'html',
      artifactId: id,
      revision,
      log,
    });

    store(id, revision, built);

    manifest.revisions.at(-1).entries = built.files;
    await writeManifest(id);

    return { files: built.files };
  };

  /** `papercraft.previews/v1.read`: the markup path A renders and its entries. */
  const readPreview = (input = {}) => {
    const manifest = manifests.get(input.artifactId);

    if (manifest === undefined || manifest.kind !== 'preview') return undefined;

    const revision = input.revision ?? manifest.revisions.length;

    if (revision < 1 || revision > manifest.revisions.length) return undefined;

    const built = payloadOf(input.artifactId, revision);

    if (built === undefined) return undefined;

    return {
      artifactId: input.artifactId,
      revision,
      kind: 'preview',
      files: built.files,
      markup: built.markup ?? '',
    };
  };

  return {
    approve,
    apply,
    build,
    create,
    dirOf,
    list,
    policy: policyOf,
    read,
    readPreview,
    revise,
    /** The payload of one revision, for the seeding report. */
    payloadOf,
  };
};
