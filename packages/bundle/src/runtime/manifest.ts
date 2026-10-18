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
) => {
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const parsed = parseContractEntry(entry);

    if (parsed === undefined) {
      return;
    }

    const issue = (message: string) =>
      context.addIssue({ code: 'custom', path: [field, index], message });

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

/** Manifest v1: identity, platform range and declared contracts; nothing else. */
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
  })
  .strict()
  .superRefine((manifest, context) => {
    checkEntries(manifest.provides, 'provides', context);
    checkEntries(manifest.requires, 'requires', context);
    checkDesktopScope(manifest.desktopScope, manifest.provides, context);
  });

export type ManifestV1 = z.output<typeof manifestV1Schema>;

export type ManifestV1Input = z.input<typeof manifestV1Schema>;

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
  readonly manifest: ManifestV1;
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

/** Parses a manifest document: v1 when `manifestVersion` is present, else v0. */
export const parseManifest = (document: unknown): ReadManifest => {
  if (
    typeof document === 'object' &&
    document !== null &&
    'manifestVersion' in document
  ) {
    return { manifest: manifestV1Schema.parse(document) };
  }

  return convertV0(manifestV0Schema.parse(document));
};
