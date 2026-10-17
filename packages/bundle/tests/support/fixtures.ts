import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { LogRecord } from '../../src/contracts/index.js';
import type {
  Descriptor,
  DescriptorEntry,
  EmbeddedBundle,
  LogSink,
  PlatformLog,
} from '../../src/index.js';
import type { ManifestV1Input } from '../../src/runtime/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** File URL of the compiled `bundle/contracts` the tests themselves load. */
export const contractsUrl = pathToFileURL(
  join(here, '..', '..', 'src', 'contracts', 'index.js'),
).href;

/** File URL of the compiled minimal core module. */
export const minimalCoreUrl = pathToFileURL(join(here, 'minimal-core.js')).href;
export const skilledProviderUrl = pathToFileURL(
  join(here, 'skilled-provider.js'),
).href;

export const withRoot = async <T>(
  run: (root: string) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-loader-'));

  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export interface ManifestOptions {
  readonly version?: string;
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
  readonly engines?: string;
  readonly description?: string;
}

export const manifest = (
  id: string,
  options: ManifestOptions = {},
): ManifestV1Input => ({
  manifestVersion: 1,
  id,
  version: options.version ?? '1.0.0',
  engines: { doric: options.engines ?? '^1.0.0' },
  provides: [...(options.provides ?? [])],
  requires: [...(options.requires ?? [])],
  ...(options.description === undefined
    ? {}
    : { description: options.description }),
});

export type ContractShape = Partial<
  Pick<DescriptorEntry, 'kind' | 'environment' | 'cardinality' | 'local'>
>;

/** A descriptor listing every `provides` entry, by default as a host `one` service. */
export const descriptorFor = (
  source: ManifestV1Input,
  shapes: Readonly<
    Record<string, ContractShape | readonly ContractShape[]>
  > = {},
): Descriptor => ({
  descriptorVersion: 1,
  bundle: { id: source.id, version: source.version },
  contracts: (source.provides ?? []).flatMap((entry) => {
    const [id, version] = entry.split('@') as [string, string];
    const configured = shapes[id];
    const list = Array.isArray(configured)
      ? (configured as readonly ContractShape[])
      : [(configured ?? {}) as ContractShape];

    return list.map((shape) => ({
      id,
      version,
      kind: shape.kind ?? 'service',
      environment: shape.environment ?? 'host',
      cardinality: shape.cardinality ?? 'one',
      local: shape.local ?? false,
      schema: `schemas/${id}.json`,
    }));
  }),
});

/** An embedded bundle from a manifest and an activate function. */
export const embedded = (
  source: ManifestV1Input,
  activate?: NonNullable<EmbeddedBundle['host']>['activate'],
  shapes?: Parameters<typeof descriptorFor>[1],
): EmbeddedBundle => ({
  manifest: source,
  descriptor: descriptorFor(source, shapes),
  ...(activate === undefined ? {} : { host: { activate } }),
});

export interface DiskBundle {
  readonly manifest: unknown;
  readonly descriptor?: unknown;
  /** Source of host/index.js. */
  readonly host?: string;
  /** Files relative to the bundle directory. */
  readonly files?: Readonly<Record<string, string>>;
}

export const writeBundle = async (
  root: string,
  directory: string,
  bundle: DiskBundle,
): Promise<string> => {
  const path = join(root, directory);
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify(bundle.manifest),
    ...(bundle.descriptor === undefined
      ? {}
      : { 'contracts.json': JSON.stringify(bundle.descriptor) }),
    ...(bundle.host === undefined ? {} : { 'host/index.js': bundle.host }),
    ...bundle.files,
  };

  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), content);
  }

  return path;
};

export const skillSource = (
  name: string,
  options: {
    readonly allowedTools?: readonly string[];
    readonly alwaysAvailable?: boolean;
    readonly order?: number;
    readonly body?: string;
  } = {},
) => `---
name: ${name}
description: ${name} description
allowed-tools: [${(options.allowedTools ?? []).join(', ')}]
${options.alwaysAvailable === undefined ? '' : `alwaysAvailable: ${options.alwaysAvailable}\n`}${options.order === undefined ? '' : `order: ${options.order}\n`}---

${options.body ?? `# ${name}\n\nFollow this procedure.`}
`;

export interface CapturedLog extends PlatformLog {
  readonly lines: {
    level: string;
    message: string;
    fields: Record<string, unknown>;
  }[];
}

export const captureLog = (): CapturedLog => {
  const lines: CapturedLog['lines'] = [];
  const at =
    (level: string) => (fields: Record<string, unknown>, message: string) => {
      lines.push({ level, message, fields });
    };

  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
};

export interface CapturedSink extends LogSink {
  readonly records: LogRecord[];
}

export const captureSink = (): CapturedSink => {
  const records: LogRecord[] = [];

  return { records, write: (record) => records.push(record) };
};
