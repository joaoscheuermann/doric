import type { Dirent } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import { orderKeySchema } from '../contracts/basic/tools.js';
import type { SkillSchemaInput } from '../contracts/skill.js';

const nameSchema = z.string().trim().min(1);

const skillFields = {
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
};

/** Frontmatter accepted by manifest v0 bundles (unknown keys rejected). */
const skillMetadataV0Schema = z.object(skillFields).strict();

/**
 * Frontmatter of v1 bundles: `alwaysAvailable` moved into SKILL.md, and the
 * global `order` key of skills/v1 1.1.0 (D10-5).
 */
const skillMetadataV1Schema = z
  .object({
    ...skillFields,
    alwaysAvailable: z.boolean().optional(),
    order: orderKeySchema.optional(),
  })
  .strict();

export interface ParsedSkill {
  readonly skill: SkillSchemaInput;
  /** From v1 frontmatter; undefined when the file does not say. */
  readonly alwaysAvailable?: boolean;
  /** From v1 frontmatter; undefined when the file does not say. */
  readonly order?: number;
}

export interface SkillParseOptions {
  /** v1 bundles may set `alwaysAvailable` and `order` in the frontmatter. */
  readonly frontmatterAvailability: boolean;
}

const withCause = (message: string, cause: unknown): Error =>
  new Error(message, { cause });

const splitSkill = (source: string, context: string) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);

  if (match === null) {
    throw new Error(`${context} must contain YAML frontmatter.`);
  }

  return { yaml: match[1] as string, body: match[2] as string };
};

/** Parses a SKILL.md document: YAML frontmatter followed by a Markdown body. */
export const parseSkillDocument = (
  source: string,
  context: string,
  options: SkillParseOptions = { frontmatterAvailability: false },
): ParsedSkill => {
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

    const { 'allowed-tools': allowedTools, ...fields } = metadata as Record<
      string,
      unknown
    >;
    const schema = options.frontmatterAvailability
      ? skillMetadataV1Schema
      : skillMetadataV0Schema;
    const { alwaysAvailable, order, ...skill } = schema.parse({
      ...fields,
      allowedTools,
      body,
    }) as SkillSchemaInput & {
      readonly alwaysAvailable?: boolean;
      readonly order?: number;
    };

    return {
      skill,
      ...(alwaysAvailable === undefined ? {} : { alwaysAvailable }),
      ...(order === undefined ? {} : { order }),
    };
  } catch (cause) {
    throw withCause(`Invalid ${context}.`, cause);
  }
};

/** Resolves a bundle-relative resource path, refusing escapes. */
export const resourcePath = (
  bundlePath: string,
  relativePath: string,
): string => {
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

export const readText = async (
  path: string,
  context: string,
): Promise<string> => {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    throw withCause(`Unable to read ${context}.`, cause);
  }
};

/** Reads and parses one skill of a bundle by its relative path. */
export const readSkill = async (
  bundlePath: string,
  relativePath: string,
  options?: SkillParseOptions,
): Promise<ParsedSkill> => {
  const context = `skill "${relativePath}" in bundle "${bundlePath}"`;
  const source = await readText(
    resourcePath(bundlePath, relativePath),
    context,
  );

  return parseSkillDocument(source, context, options);
};

const lexical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** `skills/<dir>/SKILL.md` paths of a bundle, in lexical directory order. */
export const discoverSkills = async (
  bundlePath: string,
): Promise<readonly string[]> => {
  let entries: Dirent[];

  try {
    entries = await readdir(join(bundlePath, 'skills'), {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const paths: string[] = [];

  for (const name of entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(lexical)) {
    try {
      await access(join(bundlePath, 'skills', name, 'SKILL.md'));
      paths.push(`skills/${name}/SKILL.md`);
    } catch {
      // A directory without SKILL.md is not a skill.
    }
  }

  return paths;
};
