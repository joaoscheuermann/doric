import { z } from 'zod';

import {
  SCOPE_MAX_KEYS,
  scopeKeyPattern,
  windowScopeKey,
} from '../contracts/call.js';
import {
  bundleIdPattern,
  contractIdPattern,
  isPlatformContract,
} from '../contracts/ids.js';
import { isRange, isVersion, parseVersion, rangeMajor } from './semver.js';

export const semverString = z
  .string()
  .refine(isVersion, 'Expected a semantic version (MAJOR.MINOR.PATCH).');

export const semverRange = z
  .string()
  .refine(isRange, 'Expected a semantic version range.');

const contractRefPattern =
  /^([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\/v([1-9][0-9]*))@(.+)$/;

export interface ContractEntry {
  /** Contract ID, `<id>/v<major>`. */
  readonly id: string;
  readonly major: number;
  /** Exact version (provides) or range (requires). */
  readonly spec: string;
}

/** Splits `<id>/v<major>@<version-or-range>`; undefined when malformed. */
export const parseContractEntry = (
  entry: string,
): ContractEntry | undefined => {
  const match = contractRefPattern.exec(entry);

  if (match === null) {
    return undefined;
  }

  return {
    id: match[1] as string,
    major: Number(match[2]),
    spec: match[3] as string,
  };
};

const contractRef = z
  .string()
  .regex(contractRefPattern, 'Expected "<contract>/v<major>@<version>".');

const checkEntries = (
  entries: readonly string[],
  field: 'provides' | 'requires',
  context: z.core.$RefinementCtx,
  path: readonly PropertyKey[] = [field],
) => {
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const parsed = parseContractEntry(entry);

    if (parsed === undefined) {
      return;
    }

    const issue = (message: string) =>
      context.addIssue({ code: 'custom', path: [...path, index], message });

    if (isPlatformContract(parsed.id)) {
      issue(`"${parsed.id}" is a platform contract and is never declared.`);
    }

    if (seen.has(parsed.id)) {
      issue(`"${parsed.id}" is listed more than once.`);
    }

    seen.add(parsed.id);

    if (field === 'provides') {
      const version = parseVersion(parsed.spec);

      if (version === undefined) {
        issue(`"${parsed.spec}" is not an exact version.`);
      } else if (version.major !== parsed.major) {
        issue(
          `Major of ${parsed.spec} does not match "${parsed.id}" (v${parsed.major}).`,
        );
      }
    } else if (!isRange(parsed.spec)) {
      issue(`"${parsed.spec}" is not a version range.`);
    } else if (rangeMajor(parsed.spec) !== parsed.major) {
      issue(
        `Range ${parsed.spec} must admit only major ${parsed.major} of "${parsed.id}".`,
      );
    }
  });
};

/** A scope key a desktop window may send; the platform alone sets `windowKey`, in any case. */
const desktopScopeKey = z
  .string()
  .regex(scopeKeyPattern, 'Expected a scope key.')
  .refine(
    (key) => key.toLowerCase() !== windowScopeKey.toLowerCase(),
    `"${windowScopeKey}" is set by the platform.`,
  );

/**
 * The scope keys a desktop window may send to each contract this bundle
 * provides (`desktopScope`). A key not listed here is refused at the IPC.
 */
const desktopScopeSchema = z.record(
  z.string().regex(contractIdPattern),
  z.array(desktopScopeKey).max(SCOPE_MAX_KEYS),
);

const checkDesktopScope = (
  scope: z.infer<typeof desktopScopeSchema> | undefined,
  provides: readonly string[],
  context: z.core.$RefinementCtx,
) => {
  const provided = new Set(
    provides.map((entry) => parseContractEntry(entry)?.id),
  );

  for (const [id, keys] of Object.entries(scope ?? {})) {
    const issue = (message: string) =>
      context.addIssue({
        code: 'custom',
        path: ['desktopScope', id],
        message,
      });

    if (!provided.has(id)) {
      issue(`"${id}" is not a provided contract.`);
    }

    if (new Set(keys).size !== keys.length) {
      issue(`"${id}" lists a scope key more than once.`);
    }
  }
};

/**
 * The shape of `host.httpPrefix`: one lowercase path segment between slashes,
 * `"/screen/"`. The gateway serves the bundle's HTTP routes under it
 * (spec §11). Anchored; matches the whole string or nothing.
 */
export const httpPrefixPattern = /^\/[a-z][a-z0-9-]*\/$/;

const httpPrefix = z
  .string()
  .regex(
    httpPrefixPattern,
    'Expected one path segment between slashes, "/<segment>/".',
  );

/** Relative, `/`-separated, no empty, `.` or `..` segment, no `\`. */
export const isNormalForm = (path: string): boolean =>
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

/**
 * One glob of `host.assets` (section 14, "Assets"): paths relative to the
 * bundle directory, `/`-separated, matched with `path.posix.matchesGlob`
 * (`src/host/skills/*.md`, `dist/sandbox/runner.mjs`). Refused: empty,
 * absolute (leading `/`), a `..` or `.` segment, an empty segment, a `\`.
 */
const assetGlob = z
  .string()
  .min(1)
  .refine(
    isNormalForm,
    'Expected a glob relative to the bundle directory, "/"-separated, without "." or ".." segments.',
  );

/**
 * Manifest v1: identity, platform range, declared contracts and, from phase 2,
 * an optional strict `host` that holds `httpPrefix` and `assets`. Any other `host` key is
 * refused. Its `requires` and `optional` are bundle-wide: `partLists` answers
 * them for every part.
 */
export const manifestV1Schema = z
  .object({
    manifestVersion: z.literal(1),
    id: z
      .string()
      .regex(bundleIdPattern, 'Expected a lowercase bundle ID.')
      .refine((id) => id !== 'doric', '"doric" is reserved for the platform.'),
    version: semverString,
    engines: z.object({ doric: semverRange }).strict(),
    provides: z.array(contractRef).default([]),
    requires: z.array(contractRef).default([]),
    /** Contracts usable when present, without becoming activation dependencies. */
    optional: z.array(z.string().regex(contractIdPattern)).optional(),
    desktopScope: desktopScopeSchema.optional(),
    description: z.string().trim().min(1).optional(),
    /** The host part's settings: `httpPrefix` (G7) and `assets` (D35). */
    host: z
      .object({
        httpPrefix: httpPrefix.optional(),
        assets: z.array(assetGlob).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    checkEntries(manifest.provides, 'provides', context);
    checkEntries(manifest.requires, 'requires', context);
    checkDesktopScope(manifest.desktopScope, manifest.provides, context);
  });

export type ManifestV1 = z.output<typeof manifestV1Schema>;

export type ManifestV1Input = z.input<typeof manifestV1Schema>;

/** A part of a bundle whose requirements a v2 manifest lists apart. */
export type Part = 'host' | 'client';

/** One part's lists as written: `requires` entries and `optional` ids. */
const partListFields = {
  /** `<id>/v<major>@<range>`; the part cannot activate without each. */
  requires: z.array(contractRef).default([]),
  /** Contract ids usable when present, without becoming dependencies. */
  optional: z.array(z.string().regex(contractIdPattern)).default([]),
};

/**
 * Refines one part of a v2 manifest: each `requires` entry as v1's
 * `checkEntries` refuses it, a `doric.*` id under `requires` or `optional`,
 * and a contract id listed twice in the part (under `requires` and `optional`
 * together included). Issues are reported at `[part, list, index]`.
 */
const checkPart = (
  lists: {
    readonly requires: readonly string[];
    readonly optional: readonly string[];
  },
  part: Part,
  context: z.core.$RefinementCtx,
): void => {
  checkEntries(lists.requires, 'requires', context, [part, 'requires']);

  const seen = new Set(
    lists.requires.map((entry) => parseContractEntry(entry)?.id),
  );

  lists.optional.forEach((id, index) => {
    const issue = (message: string) =>
      context.addIssue({
        code: 'custom',
        path: [part, 'optional', index],
        message,
      });

    if (isPlatformContract(id)) {
      issue(`"${id}" is a platform contract and is never declared.`);
    }

    if (seen.has(id)) {
      issue(`"${id}" is listed more than once.`);
    }

    seen.add(id);
  });
};

/**
 * Manifest v2 (A41, D30): v1's `id`, `version`, `engines`, `provides`,
 * `desktopScope` and `description` with their v1 rules, and `requires` and
 * `optional` moved under each part. `host` and `client` are optional and parse
 * to `{ requires: [], optional: [] }` when absent; `host` also holds
 * `httpPrefix` and `assets`. Unknown keys at any level are refused. Top-level `requires` or
 * `optional` is refused.
 */
export const manifestV2Schema = z
  .object({
    manifestVersion: z.literal(2),
    id: z
      .string()
      .regex(bundleIdPattern, 'Expected a lowercase bundle ID.')
      .refine((id) => id !== 'doric', '"doric" is reserved for the platform.'),
    version: semverString,
    engines: z.object({ doric: semverRange }).strict(),
    provides: z.array(contractRef).default([]),
    host: z
      .object({
        ...partListFields,
        httpPrefix: httpPrefix.optional(),
        assets: z.array(assetGlob).optional(),
      })
      .strict()
      .prefault({}),
    client: z.object(partListFields).strict().prefault({}),
    desktopScope: desktopScopeSchema.optional(),
    description: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    checkEntries(manifest.provides, 'provides', context);
    checkPart(manifest.host, 'host', context);
    checkPart(manifest.client, 'client', context);
    checkDesktopScope(manifest.desktopScope, manifest.provides, context);
  });

export type ManifestV2 = z.output<typeof manifestV2Schema>;

export type ManifestV2Input = z.input<typeof manifestV2Schema>;

/** A validated manifest of a version the platform reads. */
export type Manifest = ManifestV1 | ManifestV2;

/** The requirements of one part, as the catalog and the run-time checks read them. */
export interface PartLists {
  /** Parsed `requires` entries, in manifest order; never malformed. */
  readonly requires: readonly ContractEntry[];
  /** `optional` contract ids, in manifest order; empty when none. */
  readonly optional: readonly string[];
}

/**
 * The lists of `part` in `manifest`. A v2 manifest answers that part's own
 * lists (empty when the part's object is absent); a v1 manifest answers its
 * bundle-wide `requires` and `optional` for either part. Pure; never throws
 * on a manifest produced by `parseManifest`.
 */
export const partLists = (manifest: Manifest, part: Part): PartLists => {
  const lists = manifest.manifestVersion === 2 ? manifest[part] : manifest;

  return {
    requires: lists.requires.flatMap((entry) => {
      const parsed = parseContractEntry(entry);

      return parsed === undefined ? [] : [parsed];
    }),
    optional: lists.optional ?? [],
  };
};

/**
 * `host.httpPrefix` of either version, or undefined when the manifest sets
 * none. A defined result matches `httpPrefixPattern`.
 */
export const httpPrefixOf = (manifest: Manifest): string | undefined =>
  manifest.host?.httpPrefix;

/**
 * `host.assets` of either version, in manifest order; empty when the manifest
 * sets none. Each entry passed `assetGlob`'s rule. Pure; never throws on a
 * manifest produced by `parseManifest`.
 */
export const hostAssetsOf = (manifest: Manifest): readonly string[] =>
  manifest.host?.assets ?? [];

const nameSchema = z.string().trim().min(1);

/** Manifest v0 (the format before v1), exactly as the old loader accepted it. */
export const manifestV0Schema = z
  .object({
    name: nameSchema,
    description: z.string().trim().min(1),
    tools: z.array(
      z
        .object({
          path: z.string().regex(/^tools\/[^/]+\.js$/),
          alwaysAvailable: z.boolean(),
        })
        .strict(),
    ),
    skills: z.array(
      z
        .object({
          path: z.string().regex(/^skills\/[^/]+\/SKILL\.md$/),
          alwaysAvailable: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type ManifestV0 = z.output<typeof manifestV0Schema>;

export interface LegacyResource {
  readonly path: string;
  readonly alwaysAvailable: boolean;
}

export interface ReadManifest {
  /** v1 or v2 as written; a converted v0 manifest is v1. */
  readonly manifest: Manifest;
  /** Present only for a converted v0 manifest. */
  readonly legacy?: {
    readonly tools: readonly LegacyResource[];
    readonly skills: readonly LegacyResource[];
  };
}

/** Legacy identity stays the author's name; renames belong to the distribution. */
export const v0BundleId = (name: string): string => name;

/**
 * In-memory v0 → v1 conversion: ID from the name, version 0.0.0, any platform,
 * no provides, tools/v1 required when tools are listed. Throws when the
 * converted manifest is not a valid v1 manifest (for example a name that is
 * not a bundle ID).
 */
export const convertV0 = (v0: ManifestV0): ReadManifest => {
  const manifest = manifestV1Schema.parse({
    manifestVersion: 1,
    id: v0BundleId(v0.name),
    version: '0.0.0',
    engines: { doric: '*' },
    provides: [],
    requires: v0.tools.length > 0 ? ['tools/v1@^1.0.0'] : [],
    description: v0.description,
  });

  return {
    manifest,
    legacy: {
      tools: v0.tools.map(({ path, alwaysAvailable }) => ({
        path,
        alwaysAvailable,
      })),
      skills: v0.skills.map(({ path, alwaysAvailable }) => ({
        path,
        alwaysAvailable,
      })),
    },
  };
};

/**
 * Parses a manifest document by its `manifestVersion`: `1` with
 * `manifestV1Schema`, `2` with `manifestV2Schema`; without the key, as v0
 * converted to v1 (unchanged until phase 3). Throws a `ZodError` for any other
 * `manifestVersion` or an invalid document; the result's `manifest` is valid
 * for its version.
 */
export const parseManifest = (document: unknown): ReadManifest => {
  if (
    typeof document === 'object' &&
    document !== null &&
    'manifestVersion' in document
  ) {
    return {
      manifest:
        document.manifestVersion === 2
          ? manifestV2Schema.parse(document)
          : manifestV1Schema.parse(document),
    };
  }

  return convertV0(manifestV0Schema.parse(document));
};
