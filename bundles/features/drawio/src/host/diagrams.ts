import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';

import {
  ArtifactsV1,
  DIAGRAM_ENTRY,
  DIAGRAM_KIND,
  type DiagramExportInput,
  type DiagramRead,
  type DiagramReadInput,
  type DiagramSaved,
  type DiagramSaveInput,
  type DrawioDiagrams,
  DrawioDiagramsV1,
  drawioDiagramsMethods,
  type ExportResult,
  isSvgText,
  type LeasedSandbox,
  MAX_SVG_BYTES,
  RuntimeLeaseV1,
  USER_CHANGE_NOTE,
  utf8Bytes,
} from '../contracts/index.js';
import { normalizeDiagram } from './xml.js';

/** Lowercase hex SHA-256 of `text` as UTF-8. */
export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** One stored revision of a diagram: its `diagram.drawio` text and the artifact's revision count. */
interface StoredRevision {
  readonly xml: string;
  readonly revision: number;
  readonly revisions: number;
}

/**
 * Reads `revision` of `artifactId` through `artifacts/v1.read`, inside the
 * caller's lease: undefined when the record, the revision, its DIAGRAM_ENTRY
 * or that entry's `base64` is absent.
 */
const readRevision = async (
  services: Services,
  call: Call,
  artifactId: string,
  revision: number,
): Promise<StoredRevision | undefined> => {
  const record = await services
    .use(ArtifactsV1, call.scope)
    .read({ artifactId, revision }, call);
  const base64 = record?.entries.find(
    (entry) => entry.path === DIAGRAM_ENTRY,
  )?.base64;

  if (record === undefined || base64 === undefined) {
    return undefined;
  }

  return {
    xml: Buffer.from(base64, 'base64').toString('utf8'),
    revision: record.revision,
    revisions: record.revisions,
  };
};

/**
 * Reads one revision of a diagram through `artifacts/v1.read` inside
 * `runtime.lease/v1.withLease`. Answers `ok` with the `diagram.drawio` bytes
 * decoded as UTF-8 and the artifact's current revision count; `missing` when
 * the record, the revision, that entry or its `base64` is absent; `unleased`
 * with the lease state when `withLease` did not run. Writes nothing. Rejects
 * only with an error the artifacts call itself raised.
 */
export const readDiagram = async (
  services: Services,
  call: Call,
  input: DiagramReadInput,
): Promise<DiagramRead> => {
  const outcome = await services
    .use(RuntimeLeaseV1, call.scope)
    .withLease(async (): Promise<DiagramRead> => {
      const stored = await readRevision(
        services,
        call,
        input.artifactId,
        input.revision,
      );

      return stored === undefined
        ? { status: 'missing' }
        : { status: 'ok', ...stored };
    }, call);

  return outcome.status === 'ready'
    ? outcome.value
    : { status: 'unleased', lease: outcome.status };
};

/**
 * As `DrawioDiagrams.save`; the artifacts and lease calls carry `call` and
 * `call.scope`. Resolves with the revision that holds `input.xml` once
 * normalized: a new one noted USER_CHANGE_NOTE, or the latest when its
 * DIAGRAM_ENTRY already has the same SHA-256 (nothing written). Rejects with
 * `invalid_input` (XML refused, before the lease; not a diagram), `not_found`
 * (no artifact) or `unavailable` with `details.lease` (no lease).
 */
export const saveDiagram = async (
  services: Services,
  call: Call,
  input: DiagramSaveInput,
): Promise<DiagramSaved> => {
  const normalized = normalizeDiagram(input.xml);

  if ('error' in normalized) {
    throw new ContractError('invalid_input', normalized.error);
  }

  const hash = sha256(normalized.xml);

  const outcome = await services
    .use(RuntimeLeaseV1, call.scope)
    .withLease(async (): Promise<DiagramSaved> => {
      const artifacts = services.use(ArtifactsV1, call.scope);
      const latest = await artifacts.read(
        { artifactId: input.artifactId },
        call,
      );

      if (latest === undefined) {
        throw new ContractError(
          'not_found',
          `There is no artifact "${input.artifactId}".`,
        );
      }

      if (latest.kind !== DIAGRAM_KIND) {
        throw new ContractError(
          'invalid_input',
          `The artifact "${latest.artifactId}" is a "${latest.kind}", not a diagram.`,
        );
      }

      if (
        latest.entries.some(
          (entry) => entry.path === DIAGRAM_ENTRY && entry.sha256 === hash,
        )
      ) {
        return {
          revision: latest.revision,
          revisions: latest.revisions,
          sha256: hash,
        };
      }

      const record = await artifacts.revise(
        {
          artifactId: latest.artifactId,
          changeNote: USER_CHANGE_NOTE,
          entries: [{ path: DIAGRAM_ENTRY, sha256: hash }],
          files: [
            {
              path: DIAGRAM_ENTRY,
              base64: Buffer.from(normalized.xml, 'utf8').toString('base64'),
            },
          ],
        },
        call,
      );

      return {
        revision: record.revision,
        revisions: record.revisions,
        sha256: hash,
      };
    }, call);

  return leasedValue(outcome);
};

/** The `withLease` value, or `unavailable` with `details.lease` when it did not run. */
const leasedValue = <T>(
  outcome: { status: 'ready'; value: T } | { status: string },
): T => {
  if ('value' in outcome && outcome.status === 'ready') {
    return outcome.value;
  }

  throw new ContractError(
    'unavailable',
    `The Project has no sandbox lease (${outcome.status}).`,
    { lease: outcome.status },
  );
};

/** The longest export path, in characters. */
const MAX_EXPORT_PATH = 512;

/** An `xmlsvg` export: the `<svg>` start tag carries a `content` attribute. */
const SVG_CONTENT_ATTRIBUTE =
  /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg\b[^>]*\scontent=/;

/** Why `path` cannot be an export path, in English for the caller; undefined when it can. Pure. */
export const exportPathError = (path: string): string | undefined => {
  if (path === '') {
    return 'The path is empty.';
  }

  if (path.length > MAX_EXPORT_PATH) {
    return `The path is longer than ${MAX_EXPORT_PATH} characters.`;
  }

  if (path.startsWith('/')) {
    return 'The path must be relative to the Project, without a leading "/".';
  }

  const segments = path.split('/');

  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    return 'The path has an empty, "." or ".." segment.';
  }

  if (segments[0] === '.doric') {
    return 'The path is inside .doric/.';
  }

  if (path.endsWith('.drawio') || path.endsWith('.drawio.svg')) {
    return 'The path must not end in .drawio or .drawio.svg; the extensions are added.';
  }

  return undefined;
};

/** Why `svg` cannot be the exported `.drawio.svg` (not SVG text, no `content` attribute on `<svg>`, over MAX_SVG_BYTES); undefined when it can. Pure. */
export const exportSvgError = (svg: string): string | undefined => {
  if (!isSvgText(svg)) {
    return 'The svg is not an SVG document.';
  }

  if (!SVG_CONTENT_ATTRIBUTE.test(svg)) {
    return 'The svg has no content attribute on <svg>; it is not an xmlsvg export.';
  }

  if (utf8Bytes(svg) > MAX_SVG_BYTES) {
    return `The svg is over ${MAX_SVG_BYTES} bytes.`;
  }

  return undefined;
};

/** The message of a thrown value. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Whether `test <op>` holds for the Project-relative `rel`: exit 0 is true and
 * 1 is false; any other code, `null` or a rejection is `internal`.
 */
const probe = async (
  sandbox: LeasedSandbox,
  op: '-d' | '-e' | '-f' | '-h',
  rel: string,
): Promise<boolean> => {
  let exitCode: number | null;

  try {
    ({ exitCode } = await sandbox.exec({
      cmd: ['test', op, posix.join(sandbox.root, rel)],
    }));
  } catch (error) {
    throw new ContractError(
      'internal',
      `Could not check ${rel}: ${messageOf(error)}`,
    );
  }

  if (exitCode === 0 || exitCode === 1) {
    return exitCode === 0;
  }

  throw new ContractError(
    'internal',
    `Could not check ${rel}: test ${op} ${
      exitCode === null ? 'exited without a code' : `exited with ${exitCode}`
    }`,
  );
};

type Blocked = Extract<ExportResult, { status: 'blocked' }>;

/** The first prefix of `path`'s folder that exists and is not a folder, as `not-a-folder`; undefined when there is none. */
const checkFolders = async (
  sandbox: LeasedSandbox,
  path: string,
): Promise<Blocked | undefined> => {
  const folder = posix.dirname(path);

  if (folder === '.' || (await probe(sandbox, '-d', folder))) {
    return undefined;
  }

  const segments = folder.split('/');

  for (let index = 1; index <= segments.length; index += 1) {
    const prefix = segments.slice(0, index).join('/');

    if (await probe(sandbox, '-d', prefix)) {
      continue;
    }

    if (
      (await probe(sandbox, '-e', prefix)) ||
      (await probe(sandbox, '-h', prefix))
    ) {
      return { status: 'blocked', path: prefix, reason: 'not-a-folder' };
    }

    return undefined;
  }

  return undefined;
};

/** What is at the Project-relative `rel`: `blocked`, a regular `file`, or `absent`. */
const checkFile = async (
  sandbox: LeasedSandbox,
  rel: string,
): Promise<Blocked | 'file' | 'absent'> => {
  if (await probe(sandbox, '-h', rel)) {
    return { status: 'blocked', path: rel, reason: 'special' };
  }

  if (await probe(sandbox, '-d', rel)) {
    return { status: 'blocked', path: rel, reason: 'directory' };
  }

  if (await probe(sandbox, '-f', rel)) {
    return 'file';
  }

  if (await probe(sandbox, '-e', rel)) {
    return { status: 'blocked', path: rel, reason: 'special' };
  }

  return 'absent';
};

/** Writes `content` at the Project-relative `rel`; a failure is `internal`. */
const writeExported = async (
  sandbox: LeasedSandbox,
  rel: string,
  content: string,
): Promise<void> => {
  try {
    await sandbox.writeFile(posix.join(sandbox.root, rel), content);
  } catch (error) {
    throw new ContractError(
      'internal',
      `Could not write ${rel}: ${messageOf(error)}`,
    );
  }
};

/** As `DrawioDiagrams.export`, over `call.scope`'s lease and artifacts. */
export const exportDiagram = async (
  services: Services,
  call: Call,
  input: DiagramExportInput,
): Promise<ExportResult> => {
  const refused = exportPathError(input.path) ?? exportSvgError(input.svg);

  if (refused !== undefined) {
    throw new ContractError('invalid_input', refused);
  }

  const drawio = `${input.path}.drawio`;
  const svg = `${input.path}.drawio.svg`;

  const outcome = await services
    .use(RuntimeLeaseV1, call.scope)
    .withLease(async (sandbox): Promise<ExportResult> => {
      const stored = await readRevision(
        services,
        call,
        input.artifactId,
        input.revision,
      );

      if (stored === undefined) {
        throw new ContractError(
          'not_found',
          `Revision ${input.revision} of ${input.artifactId} does not exist.`,
        );
      }

      const blockedFolder = await checkFolders(sandbox, input.path);

      if (blockedFolder !== undefined) {
        return blockedFolder;
      }

      const existing: string[] = [];

      for (const rel of [drawio, svg]) {
        const found = await checkFile(sandbox, rel);

        if (found === 'file') {
          existing.push(rel);
        } else if (found !== 'absent') {
          return found;
        }
      }

      if (existing.length > 0 && !input.overwrite) {
        return { status: 'exists', files: existing };
      }

      await writeExported(sandbox, drawio, stored.xml);

      try {
        await writeExported(sandbox, svg, input.svg);
      } catch (error) {
        await sandbox
          .exec({ cmd: ['rm', '-f', '--', posix.join(sandbox.root, drawio)] })
          .catch(() => undefined);

        throw error;
      }

      return { status: 'written', files: [drawio, svg] };
    }, call);

  return leasedValue(outcome);
};

/** `drawio.diagrams/v1` (1.2.0: `read`, `save`, `export`) over the host's lease and artifacts services. */
export const drawioDiagramsService = defineService(DrawioDiagramsV1, {
  read: defineMethod({
    ...drawioDiagramsMethods.read,
    execute: (
      input: DiagramReadInput,
      call: Call,
      services: Services,
    ): Promise<DiagramRead> => readDiagram(services, call, input),
  }),

  save: defineMethod({
    ...drawioDiagramsMethods.save,
    execute: (
      input: DiagramSaveInput,
      call: Call,
      services: Services,
    ): Promise<DiagramSaved> => saveDiagram(services, call, input),
  }),

  export: defineMethod({
    ...drawioDiagramsMethods.export,
    execute: (
      input: DiagramExportInput,
      call: Call,
      services: Services,
    ): Promise<ExportResult> => exportDiagram(services, call, input),
  }),
});

export type { DrawioDiagrams };
