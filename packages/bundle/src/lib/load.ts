import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'yaml';
import { z } from 'zod';

import type { ToolFactory } from 'tool';

import { SkillSchema } from './schemas/skill.js';
import type { Bundle, BundleManifest, Skill } from './types/bundle.js';

const nameSchema = z.string().trim().min(1);
const toolPathSchema = z.string().regex(/^tools\/[^/]+\.js$/);
const skillPathSchema = z.string().regex(/^skills\/[^/]+\/SKILL\.md$/);

const manifestSchema = z
  .object({
    name: nameSchema,
    description: z.string().trim().min(1),
    tools: z.array(
      z
        .object({
          path: toolPathSchema,
          alwaysAvailable: z.boolean(),
        })
        .strict(),
    ),
    skills: z.array(
      z
        .object({
          path: skillPathSchema,
          alwaysAvailable: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const skillMetadataSchema = z
  .object({
    name: nameSchema,
    description: z.string().trim().min(1),
    allowedTools: z.preprocess(
      (value) =>
        typeof value === 'string'
          ? value.trim().split(/\s+/).filter(Boolean)
          : (value ?? []),
      z.array(nameSchema),
    ),
    body: z.string().trim().min(1),
    indexText: z.string().optional(),
  })
  .strict();
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const withCause = (message: string, cause: unknown): Error =>
  new Error(message, { cause });

const resourcePath = (bundlePath: string, relativePath: string): string => {
  if (isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new Error(`Invalid bundle resource path "${relativePath}".`);
  }

  const path = resolve(bundlePath, ...relativePath.split('/'));

  if (!path.startsWith(`${resolve(bundlePath)}${sep}`)) {
    throw new Error(
      `Bundle resource path escapes its bundle: "${relativePath}".`,
    );
  }

  return path;
};

const read = async (path: string, context: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    throw withCause(`Unable to read ${context}.`, cause);
  }
};

const manifest = async (bundlePath: string): Promise<BundleManifest> => {
  const path = join(bundlePath, 'manifest.json');
  const source = await read(path, `manifest "${path}"`);

  try {
    return manifestSchema.parse(JSON.parse(source));
  } catch (cause) {
    throw withCause(`Invalid manifest "${path}".`, cause);
  }
};

const splitSkill = (source: string, context: string) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);

  if (match === null) {
    throw new Error(`${context} must contain YAML frontmatter.`);
  }

  return { yaml: match[1], body: match[2] };
};

const loadSkill = async (
  bundlePath: string,
  relativePath: string,
): Promise<Skill> => {
  const context = `skill "${relativePath}" in bundle "${bundlePath}"`;
  const source = await read(resourcePath(bundlePath, relativePath), context);
  const { yaml, body } = splitSkill(source, context);

  try {
    const metadata = parse(yaml) as unknown;

    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      throw new Error('Skill frontmatter must be an object.');
    }

    const { ['allowed-tools']: allowedTools, ...fields } = metadata as Record<
      string,
      unknown
    >;

    return SkillSchema.parse(
      skillMetadataSchema.parse({ ...fields, allowedTools, body }),
    );
  } catch (cause) {
    throw withCause(`Invalid ${context}.`, cause);
  }
};

const isToolFactory = (value: unknown): value is ToolFactory => {
  if (typeof value !== 'function') {
    return false;
  }

  const candidate = value as Partial<ToolFactory>;

  return (
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0 &&
    typeof candidate.definition === 'object' &&
    candidate.definition !== null &&
    candidate.definition.name === candidate.name &&
    typeof candidate.input === 'object' &&
    candidate.input !== null &&
    typeof candidate.output === 'object' &&
    candidate.output !== null &&
    typeof candidate.definition.outputSchema === 'object' &&
    candidate.definition.outputSchema !== null
  );
};

const loadTool = async (
  bundlePath: string,
  relativePath: string,
): Promise<ToolFactory> => {
  if (relativePath.endsWith('.ts')) {
    throw new Error(
      `TypeScript tools are not supported at runtime: "${relativePath}".`,
    );
  }

  const context = `tool "${relativePath}" in bundle "${bundlePath}"`;

  try {
    const loaded = (await import(
      pathToFileURL(resourcePath(bundlePath, relativePath)).href
    )) as {
      readonly default?: unknown;
    };

    if (!isToolFactory(loaded.default)) {
      throw new Error('The default export is not a compatible ToolFactory.');
    }

    return loaded.default;
  } catch (cause) {
    throw withCause(`Unable to load ${context}.`, cause);
  }
};

const unique = (
  kind: string,
  names: Map<string, string>,
  name: string,
  context: string,
) => {
  const previous = names.get(name);

  if (previous !== undefined) {
    throw new Error(
      `Duplicate ${kind} name "${name}": ${previous} and ${context}.`,
    );
  }

  names.set(name, context);
};

/** Loads strict, manifest-declared bundles immediately below a root directory. */
export async function loadBundles(root: string): Promise<readonly Bundle[]> {
  let entries;

  try {
    entries = await readdir(resolve(root), { withFileTypes: true });
  } catch (cause) {
    throw withCause(`Unable to discover bundles in root "${root}".`, cause);
  }

  const paths = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(resolve(root), entry.name))
    .sort(compare);
  const bundleNames = new Map<string, string>();
  const skillNames = new Map<string, string>();
  const toolNames = new Map<string, string>();
  const bundles: Bundle[] = [];

  for (const bundlePath of paths) {
    const definition = await manifest(bundlePath);

    unique('bundle', bundleNames, definition.name, bundlePath);

    const tools = [];

    for (const declared of definition.tools) {
      const factory = await loadTool(bundlePath, declared.path);

      unique(
        'tool',
        toolNames,
        factory.name,
        `"${declared.path}" in bundle "${definition.name}"`,
      );

      tools.push({ factory, alwaysAvailable: declared.alwaysAvailable });
    }

    const skills = [];

    for (const declared of definition.skills) {
      const skill = await loadSkill(bundlePath, declared.path);

      unique(
        'skill',
        skillNames,
        skill.name,
        `"${declared.path}" in bundle "${definition.name}"`,
      );

      skills.push({ skill, alwaysAvailable: declared.alwaysAvailable });
    }

    const localTools = new Set(tools.map(({ factory }) => factory.name));

    for (const { skill } of skills) {
      for (const name of skill.allowedTools) {
        if (!localTools.has(name)) {
          throw new Error(
            `Skill "${skill.name}" in bundle "${definition.name}" references unavailable tool "${name}".`,
          );
        }
      }
    }

    bundles.push({
      name: definition.name,
      description: definition.description,
      tools,
      skills,
    });
  }

  return bundles;
}
