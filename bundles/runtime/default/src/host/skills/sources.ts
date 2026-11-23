import { posix } from 'node:path';

import type { Call, SkillRecord } from 'bundle/contracts';

import {
  type SkillSourceEntry,
  skillSourcesMethods,
} from '../../contracts/index.js';
import type { DefaultPorts, SkillPorts, SkillSource } from '../ports.js';

/** The folder of workspace skills, relative to the Thread's working directory. */
const WORKSPACE_SKILLS_DIR = '.agents/skills';

/** The most `SKILL.md` files one scan reads (the first ones the shell's sorted glob yields). */
const WORKSPACE_SKILLS_MAX_FILES = 64;

/** How much of each `SKILL.md` the scan reads, in bytes (its frontmatter must fit). */
const WORKSPACE_SKILL_HEAD_BYTES = 4096;

/** How long the one scan command may run. */
const WORKSPACE_SCAN_TIMEOUT_MS = 5000;

/** How long one skill source's `list` may take: the limit of the scan. */
const SOURCE_LIST_TIMEOUT_MS = WORKSPACE_SCAN_TIMEOUT_MS;

/** Where a catalog skill comes from, and what `load_skill` needs to read it. */
type SkillOrigin =
  | { readonly kind: 'bundle'; readonly body: string }
  /** `path`: the skill's SKILL.md, absolute in the sandbox. */
  | { readonly kind: 'workspace'; readonly path: string }
  /** A skill of a `default.skill-sources/v1` provider, the bundle `bundleId`. */
  | {
      readonly kind: 'source';
      readonly bundleId: string;
      readonly group?: string;
      /** What the source's `read` takes. */
      readonly reference: string;
    };

/**
 * One skill a catalog list offers. `name`: the bundle skill's name, the
 * workspace skill's directory name, or the name its source gives.
 * `description`: as its source gives it, raw.
 */
export interface CatalogSkill {
  readonly name: string;
  readonly description: string;
  readonly origin: SkillOrigin;
}

/**
 * A bundle skill registered with `alwaysAvailable: true` (keeps its
 * description for when it overflows into the built-in catalog).
 */
type AlwaysAvailableSkill = Pick<SkillRecord, 'name' | 'description' | 'body'>;

/** Every skill one prompt run can offer, read once at the start of the run. */
export interface RunSkills {
  /** In skills/v1 order. */
  readonly alwaysAvailable: readonly AlwaysAvailableSkill[];
  /** The bundle skills with `alwaysAvailable` false, in skills/v1 order. */
  readonly builtIn: readonly CatalogSkill[];
  /** In scan (sorted glob) order; [] when the scan failed or found none. */
  readonly workspace: readonly CatalogSkill[];
  /** Every skill source's skills, in provider order, each in the source's own order. */
  readonly server: readonly CatalogSkill[];
}

/** What one skill source offered to one read. */
export interface SourceSkills {
  readonly bundleId: string;
  /** In the source's order; undefined when it was left out this time. */
  readonly skills: readonly CatalogSkill[] | undefined;
}

/**
 * Prints one record per `<dir>/*\/SKILL.md` (`$1` is the directory, never
 * quoted into the script): the directory name, NUL, the file's first bytes,
 * NUL; at most `WORKSPACE_SKILLS_MAX_FILES`, in the glob's sorted order.
 */
const scanScript = `n=0
for f in "$1"/*/SKILL.md; do
  [ -f "$f" ] || continue
  [ "$n" -lt ${WORKSPACE_SKILLS_MAX_FILES} ] || break
  n=$((n + 1))
  d=\${f%/SKILL.md}
  printf '%s\\0' "\${d##*/}"
  head -c ${WORKSPACE_SKILL_HEAD_BYTES} "$f"
  printf '\\0'
done
exit 0`;

const bundleSkills = async (
  call: Call,
  ports: Pick<DefaultPorts, 'skills'>,
): Promise<Pick<RunSkills, 'alwaysAvailable' | 'builtIn'>> => {
  const registered = await ports.skills.list(call);
  const alwaysAvailable: AlwaysAvailableSkill[] = [];
  const builtIn: CatalogSkill[] = [];
  for (const { skill, alwaysAvailable: always } of registered) {
    const { name, description, body } = skill;
    if (always) alwaysAvailable.push({ name, description, body });
    else builtIn.push({ name, description, origin: { kind: 'bundle', body } });
  }
  return { alwaysAvailable, builtIn };
};

const workspaceSkills = async (
  cwd: string,
  call: Call,
  ports: Pick<DefaultPorts, 'lease'>,
): Promise<readonly CatalogSkill[]> => {
  const directory = posix.join(cwd, WORKSPACE_SKILLS_DIR);
  const { exitCode, stdout } = await ports.lease.exec(
    {
      cmd: ['sh', '-c', scanScript, 'sh', directory],
      timeoutMs: WORKSPACE_SCAN_TIMEOUT_MS,
    },
    call,
  );
  if (exitCode !== 0) return [];
  const fields = stdout.split('\0');
  const skills: CatalogSkill[] = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const name = fields[at] ?? '';
    const description = frontmatterSummary(fields[at + 1] ?? '');
    if (name === '' || description === undefined) continue;
    skills.push({
      name,
      description,
      origin: {
        kind: 'workspace',
        path: posix.join(directory, name, 'SKILL.md'),
      },
    });
  }
  return skills;
};

/** The bundle ids each prompt's Call has already warned about. */
const warned = new WeakMap<Call, Set<string>>();

/** Logs once per `call` and source that the source was left out. */
const warnLeftOut = (
  bundleId: string,
  reason: string,
  call: Call,
  ports: Pick<DefaultPorts, 'log'>,
): void => {
  const seen = warned.get(call) ?? new Set<string>();
  warned.set(call, seen);
  if (seen.has(bundleId)) return;
  seen.add(bundleId);
  ports.log.warn('Skill source left out', { bundleId, reason }, call);
};

/** `answer`, or a rejection once `ms` milliseconds pass without one. */
const within = <T>(answer: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No answer within ${ms} ms.`)),
      ms,
    );
    answer.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** One entry of a source, as the catalog lists it. */
const sourceSkill = (
  bundleId: string,
  { group, name, description, reference }: SkillSourceEntry,
): CatalogSkill => ({
  name,
  description,
  origin: {
    kind: 'source',
    bundleId,
    ...(group === undefined ? {} : { group }),
    reference,
  },
});

/** The skills of one source, or undefined (and a warning) when it is left out. */
const listSource = async (
  { bundleId, api }: SkillSource,
  cwd: string,
  call: Call,
  ports: Pick<DefaultPorts, 'log'>,
): Promise<SourceSkills> => {
  let answer: unknown;
  try {
    answer = await within(api.list({ cwd }, call), SOURCE_LIST_TIMEOUT_MS);
  } catch (error) {
    warnLeftOut(
      bundleId,
      error instanceof Error ? error.message : String(error),
      call,
      ports,
    );
    return { bundleId, skills: undefined };
  }
  const parsed = skillSourcesMethods.list.output.safeParse(answer);
  if (!parsed.success) {
    warnLeftOut(bundleId, parsed.error.message, call, ports);
    return { bundleId, skills: undefined };
  }
  return {
    bundleId,
    skills: parsed.data.skills.map((entry) => sourceSkill(bundleId, entry)),
  };
};

/**
 * Reads the skills of one prompt run under `call`.
 * - Bundle: SkillsV1.list(call), split by alwaysAvailable. A failure rejects.
 * - Workspace: one RuntimeLeaseV1.exec of `sh -c` over
 *   `<cwd>/.agents/skills` (a positional argument), whose records name each
 *   directory and the head of its SKILL.md; a file without a frontmatter
 *   description is skipped. Missing provider, rejection, a non-zero or null
 *   exit code, or a timeout → workspace [].
 * - Sources: readSourceSkills; a source left out offers nothing. No skill
 *   text is read here.
 * Never rejects because of the workspace or the skill sources.
 */
export const readRunSkills = async (
  cwd: string,
  call: Call,
  ports: SkillPorts,
): Promise<RunSkills> => {
  const [bundle, workspace, sources] = await Promise.all([
    bundleSkills(call, ports),
    readWorkspaceSkills(cwd, call, ports),
    readSourceSkills(cwd, call, ports),
  ]);
  return {
    ...bundle,
    workspace,
    server: sources.flatMap(({ skills }) => skills ?? []),
  };
};

/**
 * The workspace skills of `cwd`: the same single runtime.lease/v1 scan
 * readRunSkills uses, sorted. Never rejects: missing provider, rejection,
 * non-zero or null exit, timeout → [].
 */
export const readWorkspaceSkills = (
  cwd: string,
  call: Call,
  ports: Pick<DefaultPorts, 'lease'>,
): Promise<readonly CatalogSkill[]> =>
  // Best effort: a sandbox that cannot answer offers no skill.
  workspaceSkills(cwd, call, ports).catch(() => []);

/**
 * The skills of every `default.skill-sources/v1` provider (but `cwd`), in
 * provider order, each asked in parallel for the prompt working directory
 * `cwd`. A source whose `list` answers after 5,000 ms, rejects, or answers
 * what fails the contract's schema offers `skills: undefined` this time, and
 * is logged through `log/v1` once per `call`. Never rejects.
 */
export const readSourceSkills = async (
  cwd: string,
  call: Call,
  ports: Pick<DefaultPorts, 'skillSources' | 'log'>,
): Promise<readonly SourceSkills[]> => {
  const sources = await ports.skillSources(call);
  return Promise.all(
    sources.map((source) => listSource(source, cwd, call, ports)),
  );
};

/**
 * The Thread's working directory now, from RuntimeWorkspaceV1.cwd(call).
 * Never rejects: missing provider or rejection → undefined.
 */
export const currentCwd = async (
  call: Call,
  ports: Pick<DefaultPorts, 'cwd'>,
): Promise<string | undefined> => {
  try {
    return await ports.cwd(call);
  } catch {
    // No provider, or one that cannot answer: the directory is unknown.
    return undefined;
  }
};

/** The frontmatter's lines (without the `---` lines) and the lines after it, or undefined. */
const frontmatter = (
  source: string,
):
  | { readonly lines: readonly string[]; readonly after: readonly string[] }
  | undefined => {
  const lines = source.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return undefined;
  const close = lines.findIndex((line, at) => at > 0 && line.trim() === '---');
  const end = close === -1 ? lines.length : close;
  return { lines: lines.slice(1, end), after: lines.slice(end + 1) };
};

const indented = (line: string): boolean => /^\s/u.test(line);

/** The value of a block scalar (`>` or `|`) from its indented lines. */
const blockScalar = (folded: boolean, lines: readonly string[]): string => {
  const content = [...lines];
  while (content.length > 0 && content.at(-1)?.trim() === '') content.pop();
  if (folded) {
    return content
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(' ');
  }
  const indent = Math.min(
    ...content
      .filter((line) => line.trim() !== '')
      .map((line) => line.length - line.trimStart().length),
  );
  return content.map((line) => line.slice(indent)).join('\n');
};

/** The scalar a top-level key holds, from its first-line value and the lines after it. */
const scalar = (value: string, after: readonly string[]): string => {
  const block = /^([>|])[-+0-9]*\s*(?:#.*)?$/u.exec(value);
  if (block !== null) {
    const end = after.findIndex(
      (line) => line.trim() !== '' && !indented(line),
    );
    return blockScalar(
      block[1] === '>',
      end === -1 ? after : after.slice(0, end),
    );
  }
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    const inner = value.slice(
      1,
      value.length > 1 && value.endsWith(quote) ? -1 : undefined,
    );
    return quote === "'"
      ? inner.replaceAll("''", "'")
      : inner.replace(/\\(["\\])/gu, '$1');
  }
  const end = after.findIndex(
    (line) => !(indented(line) && line.trim() !== ''),
  );
  const continuation = end === -1 ? after : after.slice(0, end);
  return [value, ...continuation.map((line) => line.trim())]
    .filter((part) => part !== '')
    .join(' ');
};

/**
 * The value of the top-level `<key>:` of a Markdown file's YAML frontmatter,
 * leniently: the frontmatter opens with `---` and ends at the next `---` line
 * or the end of the source; only a top-level `<key>:` counts, plain
 * (more-indented continuation lines joined by one space), single- or
 * double-quoted on one line, folded `>` (lines joined by spaces) or literal
 * `|` (lines joined by `\n`), with no trailing newline. Other keys are
 * ignored. Returns undefined when there is no frontmatter, no such key, or
 * only whitespace. Never throws.
 */
export const frontmatterField = (
  source: string,
  key: string,
): string | undefined => {
  const matter = frontmatter(source);
  if (matter === undefined) return undefined;
  const prefix = `${key}:`;
  const at = matter.lines.findIndex((line) => line.startsWith(prefix));
  if (at === -1) return undefined;
  const value = (matter.lines[at] ?? '').slice(prefix.length).trim();
  const field = scalar(value, matter.lines.slice(at + 1)).trim();
  return field === '' ? undefined : field;
};

/** `frontmatterField(source, 'description')`: a SKILL.md's summary. */
export const frontmatterSummary = (source: string): string | undefined =>
  frontmatterField(source, 'description');

/**
 * The text after the frontmatter's closing `---` line, trimmed, or all of
 * source, trimmed, when it has no frontmatter. Never throws.
 */
export const skillBody = (source: string): string => {
  const matter = frontmatter(source);
  return (matter === undefined ? source : matter.after.join('\n')).trim();
};
