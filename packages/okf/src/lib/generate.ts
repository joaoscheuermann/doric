import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createOkfError,
  isAbortError,
  isOkfError,
  type OkfErrorCode,
} from './classes/okf-error.js';
import { hasRecipeHash, renderConcept } from './concept.js';
import { DEFAULT_BATCH_SIZE, DEFAULT_IGNORE } from './constants.js';
import { detectType, isSupportedType } from './detect.js';
import { parseInterface } from './interface.js';
import { loadPrompts, type Prompts } from './prompts.js';
import { recipeHash } from './recipe.js';
import { describe, selectTags, summarize } from './summarize.js';
import {
  outputPath,
  parseDescription,
  renderTree,
  type TreeEntry,
} from './tree.js';
import type { ModuleInterface } from './types/interface.js';
import type {
  GenerateResult,
  OkfConfig,
  Progress,
  ProgressEvent,
} from './types/okf.js';
import { walk } from './walk.js';

type Paths = {
  readonly root: string;
  readonly output: string;
};

type WorkContext = Paths & {
  readonly config: OkfConfig;
  readonly emit: Progress;
  readonly prompts: Prompts;
  readonly promptTarget: string;
};

type WorkOutcome = 'cached' | 'generated';

type WorkResult = {
  readonly source: string;
  readonly outcome: WorkOutcome;
};

type ResultInput = Paths & {
  readonly index: string;
  readonly files: readonly string[];
  readonly results: ReadonlyMap<string, WorkOutcome>;
};

/** Returns the conventional project-bundle output directory for a root. */
export const defaultOutput = (root: string): string =>
  path.join(path.resolve(root), '.agents', 'bundles', 'project');

/** Generates an OKF representation of a repository into its bundle root. */
export const generate = async (
  config: OkfConfig,
  root: string,
  output?: string,
): Promise<GenerateResult> => {
  const paths = await resolvePaths(root, output);
  const promptTarget = config.promptTarget ?? 'default';

  const prompts = await boundary(
    () => loadPrompts(promptTarget),
    'OKF_PROMPT_LOAD_FAILED',
  );
  const emit = gated(config.progress);

  const context: WorkContext = {
    ...paths,
    config,
    emit,
    prompts,
    promptTarget,
  };
  const results = new Map<string, WorkOutcome>();
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  let processed = 0;

  emit({
    event: 'okf.generate.start',
    batchSize,
  });

  await boundary(
    () => fs.mkdir(paths.output, { recursive: true }),
    'OKF_OUTPUT_PREPARE_FAILED',
  );

  const files = await walk(
    paths.root,
    async (file, body) => {
      const outcome = await work(context, file, body);

      processed += 1;

      terminal(emit, outcome, processed);

      results.set(file, outcome.outcome);
    },
    {
      batchSize,
      ignore: [...DEFAULT_IGNORE, ...(config.ignore ?? [])],
      signal: config.signal,
    },
  );

  emit({ event: 'okf.index.start', files: files.length });

  const index = path.join(paths.output, 'index.md');

  await boundary(async () => {
    const entries = await Promise.all(files.map((file) => entry(paths, file)));

    await fs.writeFile(index, renderTree(entries), 'utf-8');
  }, 'OKF_INDEX_FAILED');

  emit({ event: 'okf.index.complete', files: files.length });

  const generated = result({ ...paths, index, files, results });

  emit({
    event: 'okf.generate.complete',
    files: generated.files.length,
    generated: generated.generated,
    cached: generated.cached,
  });

  return generated;
};

const terminal = (
  emit: Progress,
  result: WorkResult,
  processed: number,
): void => {
  const event: ProgressEvent = {
    event:
      result.outcome === 'cached' ? 'okf.file.cached' : 'okf.file.generated',
    source: result.source,
    processed,
  };

  emit(event);
};

const gated = (observer: Progress | undefined): Progress => {
  let failed = false;

  return (event) => {
    if (failed || observer === undefined) {
      return;
    }

    try {
      observer(event);
    } catch (error) {
      failed = true;

      throw error;
    }
  };
};

const work = async (
  context: WorkContext,
  file: string,
  content: string,
): Promise<WorkResult> => {
  const source = relativeFile(context.root, file);

  context.emit({ event: 'okf.file.start', source });

  const type = detectType(source);

  const moduleInterface = await interfaceFor(
    context.root,
    source,
    type,
    content,
  );

  const hash = recipeHash({
    config: context.config,
    content,
    interface: moduleInterface,
    path: source,
    prompts: context.prompts,
    promptTarget: context.promptTarget,
    type,
  });
  const target = path.join(context.output, outputPath(source));

  if (await cached(target, hash, source)) {
    return { source, outcome: 'cached' };
  }

  context.emit({ event: 'okf.file.cache.miss', source });

  const completionConfig = {
    provider: context.config.provider,
    model: context.config.model,
    effort: context.config.effort,
    signal: context.config.signal,
  };

  context.emit({ event: 'okf.file.summary.start', source });

  const sourceSummary = await boundary(
    () =>
      summarize(completionConfig, context.prompts.summary, {
        path: source,
        type,
        interface: moduleInterface,
        content,
      }),
    'OKF_SUMMARY_FAILED',
    source,
  );

  context.emit({ event: 'okf.file.summary.complete', source });

  context.emit({ event: 'okf.file.description.start', source });

  const description = await boundary(
    () =>
      describe(
        completionConfig,
        context.prompts.description,
        source,
        sourceSummary,
      ),
    'OKF_DESCRIPTION_FAILED',
    source,
  );

  context.emit({ event: 'okf.file.description.complete', source });

  context.emit({ event: 'okf.file.tags.start', source });

  const tags = await boundary(
    () =>
      selectTags(completionConfig, context.prompts.tags, source, sourceSummary),
    'OKF_TAGS_FAILED',
    source,
  );

  context.emit({ event: 'okf.file.tags.complete', source });

  await boundary(
    async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });

      await fs.writeFile(
        target,
        renderConcept({
          analysis: sourceSummary,
          description,
          tags,
          source,
          type,
          hash,
          interface: moduleInterface,
          timestamp: new Date().toISOString(),
        }),
        'utf-8',
      );
    },
    'OKF_CONCEPT_WRITE_FAILED',
    source,
  );

  return { source, outcome: 'generated' };
};

const interfaceFor = (
  root: string,
  source: string,
  type: string,
  content: string,
): Promise<ModuleInterface | undefined> =>
  isSupportedType(type)
    ? parseInterface({ root, source, type, content })
    : Promise.resolve(undefined);

const resolvePaths = async (root: string, output?: string): Promise<Paths> => {
  const resolvedRoot = await boundary(async () => {
    const resolved = await fs.realpath(path.resolve(root));
    const stat = await fs.stat(resolved);

    if (!stat.isDirectory()) {
      throw createOkfError('OKF_ROOT_INVALID');
    }

    return resolved;
  }, 'OKF_ROOT_INVALID');
  const bundleRoot = path.join(resolvedRoot, '.agents', 'bundles');

  const resolvedOutput =
    output === undefined
      ? defaultOutput(resolvedRoot)
      : path.resolve(resolvedRoot, output);

  if (!isChild(path.relative(bundleRoot, resolvedOutput))) {
    throw createOkfError('OKF_OUTPUT_INVALID');
  }

  const [physicalBundle, physicalOutput] = await boundary(
    () =>
      Promise.all([
        projectedRealPath(bundleRoot),
        projectedRealPath(resolvedOutput),
      ]),
    'OKF_OUTPUT_INVALID',
  );

  if (
    !isContained(resolvedRoot, physicalBundle) ||
    !isContained(physicalBundle, physicalOutput)
  ) {
    throw createOkfError('OKF_OUTPUT_INVALID');
  }

  return { root: resolvedRoot, output: resolvedOutput };
};

const projectedRealPath = async (target: string): Promise<string> => {
  let current = target;

  while (true) {
    try {
      const resolved = await fs.realpath(current);

      return path.resolve(resolved, path.relative(current, target));
    } catch (error) {
      if (!isAbsent(error)) {
        throw error;
      }
    }

    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error(`Cannot resolve path: ${target}`);
    }

    current = parent;
  }
};

const entry = async (paths: Paths, file: string): Promise<TreeEntry> => {
  const relative = relativeFile(paths.root, file);

  const markdown = await fs.readFile(
    path.join(paths.output, outputPath(relative)),
    'utf-8',
  );

  return { path: relative, description: parseDescription(markdown) };
};

const result = (input: ResultInput): GenerateResult => {
  const values = [...input.results.values()];

  return {
    root: input.root,
    output: input.output,
    index: input.index,
    files: input.files.map((file) => relativeFile(input.root, file)),
    generated: values.filter((value) => value === 'generated').length,
    cached: values.filter((value) => value === 'cached').length,
  };
};

const relativeFile = (root: string, file: string): string => {
  const relative = path.relative(root, file);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Cannot represent a file outside the OKF root: ${file}`);
  }

  return relative.split(path.sep).join('/');
};

const cached = async (
  file: string,
  hash: string,
  source: string,
): Promise<boolean> => {
  try {
    return hasRecipeHash(await fs.readFile(file, 'utf-8'), hash);
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }

    if (isOkfError(error) || isAbortError(error)) {
      throw error;
    }

    throw createOkfError('OKF_CACHE_READ_FAILED', source);
  }
};

const isContained = (parent: string, child: string): boolean =>
  isChild(path.relative(parent, child));

const isChild = (relative: string): boolean =>
  relative.length > 0 &&
  relative !== '..' &&
  !relative.startsWith(`..${path.sep}`) &&
  !path.isAbsolute(relative);

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const isAbsent = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

const boundary = async <Result>(
  operation: () => Promise<Result>,
  code: OkfErrorCode,
  source?: string,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (isOkfError(error) || isAbortError(error)) {
      throw error;
    }

    throw createOkfError(code, source);
  }
};
