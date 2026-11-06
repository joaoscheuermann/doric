// `papercraft.programs/v1` (D14, D16): the library and export answers, the
// host memo, the per-Project job queue and the failure rules. The library
// instruct (D28, `library.ts`) reads the `cwd`'s last answer from here.

import { createHash } from 'node:crypto';

import {
  type AnyServiceDefinition,
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';

import {
  type ExportAnswer,
  FilesV1,
  type LibraryAnswer,
  type ModuleEntries,
  type ModuleRef,
  PapercraftProgramsV1,
  papercraftProgramsMethods,
} from '../contracts/index.js';
import {
  type LibraryComponent,
  type LibraryOutput,
  type LibraryRunnerInput,
  libraryOutputSchema,
  type Manifest,
  type RunnerInput,
  type RunnerOutput,
  runnerOutputSchema,
} from '../sandbox/protocol.js';
import {
  bundleHostPackages,
  compileComponent,
  windowServes,
} from './compile.js';
import { compileStyles, type StyleAsset } from './css.js';
import { probeBytes, probeRepositoryRoot, probeSource } from './files.js';
import { projectPath } from './paths.js';
import { type SandboxBundler, sandboxBundleOf } from './sandbox.js';

/** One file of a module, as the memo holds it. */
export interface ModuleFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/**
 * D14's last answer of a `cwd`, which the library instruct reads (D28): the
 * root found, no root, or why the walk could not run.
 */
export type LastAnswer =
  | { readonly root: string }
  | { readonly none: true }
  | { readonly failed: string };

/** One memo entry: the last answer of its key, its manifest and its module. */
export interface MemoEntry {
  readonly root?: string;
  readonly manifest?: Manifest;
  readonly module?: {
    readonly ref: ModuleRef;
    readonly files: readonly ModuleFile[];
  };
  readonly components?: readonly LibraryComponent[];
  /** The failure kept for the key, at most 4,096 characters. */
  readonly error?: string;
  /** `git check-ignore -v`'s rule hiding the root's `schemas/`, when one does. */
  readonly ignoredBy?: string;
}

/** One runner job as the host hands it to `runJob`: the runner's input without its esbuild fields. */
export type JobRequest =
  | Omit<LibraryRunnerInput, 'esbuild' | 'version'>
  | Omit<RunnerInput, 'esbuild' | 'version'>;

export interface ProgramsDeps {
  /**
   * Runs one job in the Project's sandbox and answers the runner's output:
   * `LibraryOutput` for a library job, `RunnerOutput` for a bundle, or
   * `unavailable` when the sandbox cannot run it. Called at most two at a time
   * per Project, library jobs ahead of exports.
   */
  readonly runJob: (
    projectId: string,
    job: JobRequest,
  ) => Promise<LibraryOutput | RunnerOutput>;
  /**
   * The `cwd` a fence at `turnSequence` of the Thread is bound to (D10), after
   * reading the Thread's events past the entry's cursor; `undefined` when no
   * `papercraft.cwd/v1` event lies below it. `library` answers `none` then.
   */
  readonly cwdAt: (
    scope: { readonly projectId: string; readonly threadId: string },
    turnSequence: number,
  ) => Promise<string | undefined>;
  /** The clock of the 5-minute hold; `Date.now` when absent. */
  readonly now?: () => number;
}

export interface ProgramsHost {
  /** `papercraft.programs/v1`, ready for `services.provide`. */
  readonly service: AnyServiceDefinition;
  /**
   * The library of `cwd` in `projectId` (D14): the memo's answer while it is
   * fresh, else one library job (a call during a job waits for the next
   * one). Never rejects: failures answer `failed`.
   */
  libraryFor(projectId: string, cwd: string): Promise<LibraryAnswer>;
  /** The `cwd`'s last answer, or `undefined` before its first job. */
  lastAnswerOf(projectId: string, cwd: string): LastAnswer | undefined;
  /** The memo entry of `(projectId, 'library', root)`, or `undefined`. */
  memoOf(projectId: string, root: string): MemoEntry | undefined;
}

/** D11: the library answer when the Project has no sandbox lease. */
export const NO_SANDBOX =
  "The Project's sandbox is not running; repository components need it";

/** D14: how long a crashed or timed-out job holds its `cwd`. */
export const HOLD_MS = 5 * 60 * 1000;

/** D14: the jobs one Project runs at once. */
export const PROJECT_JOBS = 2;

/** D14: the module bytes the host memo keeps, least recently used first out. */
export const MAX_MEMO_BYTES = 64 * 1_048_576;

const MAX_ERROR = 4_096;

/** The runner's reasons that no retry within minutes changes: no hold. */
const LASTING = [
  'the sandbox has no `node`',
  'the sandbox has esbuild',
  'esbuild could not be loaded',
  'this host was built without the sandbox runner',
];

const NO_LEASE = 'the Project has no sandbox lease';

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const utf8 = (text: string): Uint8Array => Buffer.from(text, 'utf8');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const clip = (text: string): string => text.slice(0, MAX_ERROR);

/** A module of `built` files: its `dir` hashes their sorted `<path>:<sha256>` lines. */
const moduleOf = (
  built: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): { readonly ref: ModuleRef; readonly files: readonly ModuleFile[] } => {
  const files = built
    .map(({ path, bytes }) => ({ path, sha256: sha256(bytes), bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const dir = sha256(
    files.map(({ path, sha256: hash }) => `${path}:${hash}`).join('\n'),
  );

  return {
    ref: {
      dir,
      files: files.map(({ path, sha256: hash }) => ({ path, sha256: hash })),
    },
    files,
  };
};

/** The files of a compiled module: `index.js`, `index.css` and its assets. */
const builtFiles = (
  js: string,
  css: string,
  assets: readonly StyleAsset[],
): readonly { readonly path: string; readonly bytes: Uint8Array }[] => [
  { path: 'index.js', bytes: utf8(js) },
  ...(css === '' ? [] : [{ path: 'index.css', bytes: utf8(css) }]),
  ...assets,
];

const bytesOf = (entry: MemoEntry): number =>
  (entry.module?.files ?? []).reduce(
    (total, file) => total + file.bytes.byteLength,
    0,
  );

/** One library job shared by the calls that join it before it starts (D14). */
interface SharedJob {
  started: boolean;
  promise: Promise<LibraryAnswer>;
}

interface QueuedTask {
  readonly kind: 'library' | 'export';
  readonly start: () => void;
}

const scopeOf = (call: Call): { projectId: string; threadId: string } => {
  const projectId = call.scope?.projectId;
  const threadId = call.scope?.threadId;

  if (projectId === undefined || threadId === undefined) {
    throw new ContractError(
      'invalid_scope',
      'papercraft.programs/v1 needs a Project and Thread scope.',
    );
  }

  return { projectId, threadId };
};

/**
 * Creates the programs host over `services` and `deps`. Each call makes an
 * independent memo and queue: two hosts share nothing. Never throws.
 */
export const createPrograms = (
  services: Services,
  deps: ProgramsDeps,
): ProgramsHost => {
  const now = deps.now ?? Date.now;
  /** Least recently used first: a use moves its key to the end. */
  const memo = new Map<string, MemoEntry>();
  const lastRoots = new Map<string, string>();
  const lastAnswers = new Map<string, LastAnswer>();
  const holds = new Map<string, { until: number; answer: LibraryAnswer }>();
  const shared = new Map<string, { current?: SharedJob; next?: SharedJob }>();
  const queues = new Map<string, { running: number; waiting: QueuedTask[] }>();

  const memoKey = (
    projectId: string,
    kind: 'library' | 'export',
    name: string,
  ) => `${projectId}\0${kind}\0${name}`;
  const cwdKey = (projectId: string, cwd: string) => `${projectId}\0${cwd}`;

  const touch = (key: string): MemoEntry | undefined => {
    const entry = memo.get(key);
    if (entry !== undefined) {
      memo.delete(key);
      memo.set(key, entry);
    }

    return entry;
  };

  const remember = (key: string, entry: MemoEntry): void => {
    memo.delete(key);
    memo.set(key, entry);

    let total = 0;
    for (const value of memo.values()) total += bytesOf(value);

    for (const [oldest, value] of memo) {
      if (total <= MAX_MEMO_BYTES) break;
      if (oldest === key) continue;
      memo.delete(oldest);
      total -= bytesOf(value);
    }
  };

  /* The per-Project queue: two jobs at once, library jobs ahead of exports. */

  const pump = (queue: { running: number; waiting: QueuedTask[] }): void => {
    while (queue.running < PROJECT_JOBS) {
      const task = queue.waiting.shift();
      if (task === undefined) return;
      queue.running += 1;
      task.start();
    }
  };

  const queued = <T>(
    projectId: string,
    kind: 'library' | 'export',
    run: () => Promise<T>,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const queue = queues.get(projectId) ?? { running: 0, waiting: [] };
      queues.set(projectId, queue);
      const task: QueuedTask = {
        kind,
        start: () => {
          run()
            .then(resolve, reject)
            .finally(() => {
              queue.running -= 1;
              pump(queue);
            });
        },
      };
      const after =
        kind === 'library'
          ? queue.waiting.filter((item) => item.kind === 'library').length
          : queue.waiting.length;
      queue.waiting.splice(after, 0, task);
      pump(queue);
    });

  /* Library jobs (D14). */

  const libraryOutput = async (
    projectId: string,
    job: Omit<LibraryRunnerInput, 'esbuild' | 'version'>,
    started: () => void,
  ): Promise<LibraryOutput> => {
    const parsed = libraryOutputSchema.safeParse(
      await queued(projectId, 'library', async () => {
        // A call in the same turn as the job's start still joins it.
        await Promise.resolve();
        started();

        return deps.runJob(projectId, job);
      }),
    );

    return parsed.success
      ? parsed.data
      : {
          status: 'unavailable',
          reason: "the runner's output is not a library answer",
        };
  };

  /** Asks the runner, once more when the window does not serve a specifier. */
  const askLibrary = async (
    projectId: string,
    job: Omit<LibraryRunnerInput, 'esbuild' | 'version' | 'windowUnserved'>,
    started: () => void,
  ): Promise<LibraryOutput> => {
    const first = await libraryOutput(
      projectId,
      { ...job, windowUnserved: [] },
      started,
    );

    if (first.status !== 'built' || first.windowSpecifiers.length === 0) {
      return first;
    }

    const { build } = await import('esbuild');
    const unserved: string[] = [];
    for (const specifier of first.windowSpecifiers) {
      if (!(await windowServes(build, specifier))) unserved.push(specifier);
    }

    return unserved.length === 0
      ? first
      : libraryOutput(projectId, { ...job, windowUnserved: unserved }, started);
  };

  /** The `files/v1` reads of the CSS step, hashed into the manifest (D14). */
  const hashingReaders = (
    projectId: string,
    styles: Record<string, string>,
  ) => {
    const files = () => services.use(FilesV1, { projectId });
    const read: Record<string, string | null> = {};

    return {
      read: async (path: string): Promise<string | undefined> => {
        const known = styles[path];
        if (known !== undefined) return known;

        const outcome = await files().content({ path });
        if (outcome.status !== 'ready') {
          throw new Error(
            `The Project sandbox is not ready to read "${path}" (${outcome.status}).`,
          );
        }

        const value = outcome.value;
        const content =
          value.status === 'read' && !value.truncated && !value.binary
            ? value.content
            : undefined;
        read[path] = content === undefined ? null : sha256(utf8(content));

        return content;
      },
      readBytes: async (path: string): Promise<Uint8Array | undefined> => {
        const outcome = await Promise.resolve()
          .then(() => files().content({ path, encoding: 'base64' }))
          .catch(() => undefined);
        const value = outcome?.status === 'ready' ? outcome.value : undefined;
        const bytes =
          value?.status === 'read' && !value.truncated
            ? Buffer.from(value.content, 'base64')
            : undefined;
        read[path] = bytes === undefined ? null : sha256(bytes);

        return bytes;
      },
      manifest: (): Manifest => read,
    };
  };

  /** Finishes a built library on the host: host packages and the sheet. */
  const finish = async (
    projectId: string,
    output: Extract<LibraryOutput, { status: 'built' }>,
  ): Promise<MemoEntry> => {
    const { build } = await import('esbuild');
    const js =
      output.hostSpecifiers.length === 0
        ? output.js
        : await bundleHostPackages(build, output.js);
    const readers = hashingReaders(projectId, output.styles);
    const sheet = await compileStyles({
      read: readers.read,
      readBytes: readers.readBytes,
      sources: new Map(Object.entries(output.sources)),
      globalCss: output.globalCss,
      componentCss: output.componentCss,
    });

    return {
      root: output.root,
      manifest: { ...output.manifest, ...readers.manifest() },
      module: moduleOf(builtFiles(js, sheet.css, sheet.assets)),
      components: output.components,
      ...(output.ignoredBy === undefined
        ? {}
        : { ignoredBy: output.ignoredBy }),
    };
  };

  const answerOfEntry = (
    root: string,
    entry: MemoEntry | undefined,
  ): LibraryAnswer =>
    entry?.module !== undefined
      ? { status: 'ready', root, module: entry.module.ref }
      : {
          status: 'failed',
          root,
          error: clip(entry?.error ?? 'The library is not built.'),
        };

  /** Runs one library job for `cwd` and records its answer (D14). */
  const runLibrary = async (
    projectId: string,
    cwd: string,
    started: () => void,
  ): Promise<LibraryAnswer> => {
    const key = cwdKey(projectId, cwd);
    const previousRoot = lastRoots.get(key);
    const previous =
      previousRoot === undefined
        ? undefined
        : memo.get(memoKey(projectId, 'library', previousRoot));
    const output = await askLibrary(
      projectId,
      {
        kind: 'library',
        cwd,
        ...(previousRoot !== undefined && previous?.manifest !== undefined
          ? { previous: { root: previousRoot, manifest: previous.manifest } }
          : {}),
      },
      started,
    );

    let answer: LibraryAnswer;

    switch (output.status) {
      case 'unavailable': {
        if (output.reason.startsWith(NO_LEASE)) {
          const entry =
            previousRoot === undefined
              ? undefined
              : touch(memoKey(projectId, 'library', previousRoot));
          answer =
            previousRoot !== undefined && entry?.module !== undefined
              ? answerOfEntry(previousRoot, entry)
              : { status: 'failed', error: NO_SANDBOX };
          break;
        }

        answer = {
          status: 'failed',
          error: clip(
            `The sandbox could not run the library job: ${output.reason}`,
          ),
        };

        if (!LASTING.some((lasting) => output.reason.startsWith(lasting))) {
          holds.set(key, { until: now() + HOLD_MS, answer });
        }
        break;
      }
      case 'none':
        answer = { status: 'none' };
        break;
      case 'unchanged':
        answer = answerOfEntry(
          output.root,
          touch(memoKey(projectId, 'library', output.root)),
        );
        break;
      case 'failed':
        if (output.root !== undefined) {
          remember(memoKey(projectId, 'library', output.root), {
            root: output.root,
            manifest: output.manifest,
            error: clip(output.error),
            ...(output.ignoredBy === undefined
              ? {}
              : { ignoredBy: output.ignoredBy }),
          });
        }
        answer = {
          status: 'failed',
          ...(output.root === undefined ? {} : { root: output.root }),
          error: clip(output.error),
        };
        break;
      case 'built': {
        const entry = await finish(projectId, output).catch(
          (error: unknown): MemoEntry => ({
            root: output.root,
            manifest: output.manifest,
            error: clip(messageOf(error)),
          }),
        );
        remember(memoKey(projectId, 'library', output.root), entry);
        answer = answerOfEntry(output.root, entry);
        break;
      }
    }

    const root = answer.status === 'none' ? undefined : answer.root;
    if (root !== undefined) lastRoots.set(key, root);
    lastAnswers.set(
      key,
      root !== undefined
        ? { root }
        : answer.status === 'failed'
          ? { failed: answer.error }
          : { none: true },
    );

    return answer;
  };

  /** A shared job for `cwd`, queued once `after` settles. */
  const sharedJob = (
    projectId: string,
    cwd: string,
    after: Promise<unknown>,
  ): SharedJob => {
    const job: SharedJob = {
      started: false,
      promise: Promise.resolve({ status: 'none' }),
    };
    job.promise = after
      .catch(() => undefined)
      .then(() =>
        runLibrary(projectId, cwd, () => {
          job.started = true;
        }),
      )
      .catch(
        (error: unknown): LibraryAnswer => ({
          status: 'failed',
          error: clip(messageOf(error)),
        }),
      );

    return job;
  };

  const libraryFor = (
    projectId: string,
    cwd: string,
  ): Promise<LibraryAnswer> => {
    const key = cwdKey(projectId, cwd);
    const hold = holds.get(key);

    if (hold !== undefined) {
      if (now() < hold.until) return Promise.resolve(hold.answer);
      holds.delete(key);
    }

    const state = shared.get(key) ?? {};
    shared.set(key, state);

    if (state.current !== undefined && !state.current.started) {
      return state.current.promise;
    }

    if (state.current === undefined) {
      const current = sharedJob(projectId, cwd, Promise.resolve());
      state.current = current;
      void current.promise.finally(() => {
        state.current = state.next;
        state.next = undefined;
        if (state.current === undefined) shared.delete(key);
      });

      return current.promise;
    }

    if (state.next === undefined) {
      const next = sharedJob(projectId, cwd, state.current.promise);
      state.next = next;
      void next.promise.finally(() => {
        if (state.current === next) {
          state.current = state.next;
          state.next = undefined;
          if (state.current === undefined) shared.delete(key);
        }
      });
    }

    return state.next.promise;
  };

  /* Exports (D16). */

  const exportModule = async (
    input: { readonly path: string; readonly name?: string },
    call: Call,
  ): Promise<ExportAnswer> => {
    const { projectId } = scopeOf(call);
    const path = projectPath('.', input.path);

    if (path === undefined) {
      return { status: 'failed', error: 'The path leaves the Project' };
    }

    const bundler: SandboxBundler = async (request) => {
      const job: Omit<RunnerInput, 'esbuild' | 'version'> = {
        path: request.path,
        ...(request.entry === undefined ? {} : { entry: request.entry }),
        windowUnserved: request.windowUnserved,
      };
      const parsed = runnerOutputSchema.safeParse(
        await queued(projectId, 'export', () => deps.runJob(projectId, job)),
      );

      return parsed.success
        ? sandboxBundleOf(parsed.data)
        : {
            status: 'unavailable',
            reason: "the runner's output is not a bundle answer",
          };
    };

    try {
      const compiled = await compileComponent(
        (file) => probeSource(services, call, file),
        { path, ...(input.name === undefined ? {} : { entry: input.name }) },
        bundler,
        (file) => probeBytes(services, call, file),
        (dir) => probeRepositoryRoot(services, call, dir),
      );
      const module = moduleOf(
        builtFiles(compiled.js, compiled.css, compiled.assets),
      );

      remember(memoKey(projectId, 'export', `${path}#${input.name ?? ''}`), {
        module,
      });

      return { status: 'ready', module: module.ref };
    } catch (error) {
      return { status: 'failed', error: clip(messageOf(error)) };
    }
  };

  /* `read`. */

  const read = (dir: string, call: Call): ModuleEntries => {
    const { projectId } = scopeOf(call);
    const prefix = `${projectId}\0`;
    const key = [...memo.entries()].find(
      ([name, entry]) =>
        name.startsWith(prefix) && entry.module?.ref.dir === dir,
    )?.[0];
    const files = key === undefined ? undefined : touch(key)?.module?.files;

    if (files === undefined) {
      throw new ContractError(
        'not_found',
        `No module ${dir} is in the host memo.`,
      );
    }

    return {
      entries: files.map((file) => ({
        path: `${dir}/${file.path}`,
        sha256: file.sha256,
        base64: Buffer.from(file.bytes).toString('base64'),
      })),
    };
  };

  const service = defineService(PapercraftProgramsV1, {
    library: defineMethod({
      ...papercraftProgramsMethods.library,
      execute: async (
        input: { readonly turnSequence: number },
        call: Call,
      ): Promise<LibraryAnswer> => {
        const scope = scopeOf(call);
        const cwd = await deps.cwdAt(scope, input.turnSequence);

        return cwd === undefined
          ? { status: 'none' }
          : libraryFor(scope.projectId, cwd);
      },
    }),
    export: defineMethod({
      ...papercraftProgramsMethods.export,
      execute: (
        input: { readonly path: string; readonly name?: string },
        call: Call,
      ): Promise<ExportAnswer> => exportModule(input, call),
    }),
    read: defineMethod({
      ...papercraftProgramsMethods.read,
      execute: (
        input: { readonly dir: string },
        call: Call,
      ): Promise<ModuleEntries> =>
        Promise.resolve().then(() => read(input.dir, call)),
    }),
  });

  return {
    service,
    libraryFor,
    lastAnswerOf: (projectId, cwd) => lastAnswers.get(cwdKey(projectId, cwd)),
    memoOf: (projectId, root) => memo.get(memoKey(projectId, 'library', root)),
  };
};
