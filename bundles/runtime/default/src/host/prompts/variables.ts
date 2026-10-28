import type { Call, Services } from 'bundle/contracts';
import type { ConfigurationProfile } from 'host-config/contracts';
import { RuntimeLeaseV1 } from 'runtime/contracts';

/**
 * The standard values the default system prompt renders, by the names
 * `system.md` cites. A `type`, not an `interface`, so it is a `TemplateView`.
 * - `os`: the leased sandbox's operating system, `"<PRETTY_NAME> (<uname -srm>)"`,
 *   e.g. `"Debian GNU/Linux 12 (bookworm) (Linux 6.1.0 x86_64)"`. Absent when it
 *   could not be read.
 * - `date`: the calendar day, `YYYY-MM-DD`, in `timezone`. Never a time of day.
 * - `timezone`: the IANA zone the date is given in: the profile's, else the host's.
 * - `user`: present only when the profile names the person; `name` as configured.
 */
export type PromptVariables = {
  readonly os?: string;
  readonly date: string;
  readonly timezone: string;
  readonly user?: { readonly name: string };
};

/** A name a template may cite for `PromptVariables`: each key, and `user.name`. */
type PromptVariableName =
  | keyof PromptVariables
  | `user.${keyof NonNullable<PromptVariables['user']>}`;

/** Every name `system.md` may cite, for `loadTemplate`; `user` for `{{#user}}`. */
export const promptVariableNames = [
  'os',
  'date',
  'timezone',
  'user',
  'user.name',
] as const satisfies readonly PromptVariableName[];

/** The longest the one OS probe command may run, in milliseconds. */
const OS_PROBE_TIMEOUT_MS = 5000;

/** Prints `uname -srm` on its first line and the os-release `PRETTY_NAME` on its second. */
const osProbeScript =
  'uname -srm && . /etc/os-release && printf \'%s\\n\' "$PRETTY_NAME"';

/**
 * The prompt variables at `now`, with no I/O: `os` only when given, `user` only
 * when `profile.name` is set, and the zone `profile.timezone` else the host's.
 * Throws `RangeError` for a zone `Intl` does not know; host-config validates
 * the zone, so a stored configuration does not. Pure.
 */
export const promptVariables: (input: {
  readonly profile?: ConfigurationProfile;
  readonly now: Date;
  readonly os?: string;
}) => PromptVariables = ({ profile, now, os }) => {
  const timezone =
    profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  return {
    ...(os === undefined ? {} : { os }),
    date,
    timezone,
    ...(profile?.name === undefined ? {} : { user: { name: profile.name } }),
  };
};

/**
 * Reads one run's prompt variables for the Thread's Project `projectId`, from
 * the configuration's `profile` (absent: no name, host zone), under the run's
 * `call` and `services`. Reads the clock once per call.
 *
 * `os` is absent when there is no `runtime.lease/v1` provider, when
 * `describe` or `exec` rejects (or throws), or when the probe exits non-zero,
 * exits null (timeout) or prints an empty value. None of these makes it reject.
 * Rejects only with `promptVariables`' `RangeError` for an unknown time zone.
 */
export type RunVariables = (
  projectId: string,
  profile: ConfigurationProfile | undefined,
  call: Call,
  services: Services,
) => Promise<PromptVariables>;

/** The `os` value of a probe's stdout, or undefined when a line is missing or empty. */
const parseOs = (stdout: string): string | undefined => {
  const [uname = '', prettyName = ''] = stdout
    .split('\n')
    .map((line) => line.trim());
  return uname === '' || prettyName === ''
    ? undefined
    : `${prettyName} (${uname})`;
};

/**
 * A `RunVariables` reading the clock from `now`, with its own in-memory OS
 * cache keyed by `projectId` and `RuntimeLeaseV1.describe().id`. Every call
 * asks `describe`; a miss runs `osProbeScript` once and caches only a
 * non-empty `os`, so a failed probe is tried again on the next run. Two
 * concurrent misses may each probe.
 */
export const createRunVariables: (now: () => Date) => RunVariables = (now) => {
  const cache = new Map<string, string>();

  const readOs = async (
    projectId: string,
    call: Call,
    services: Services,
  ): Promise<string | undefined> => {
    const lease = services.use(RuntimeLeaseV1);
    const { id } = await lease.describe(call);
    const key = JSON.stringify([projectId, id]);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const { exitCode, stdout } = await lease.exec(
      { cmd: ['sh', '-c', osProbeScript], timeoutMs: OS_PROBE_TIMEOUT_MS },
      call,
    );
    const os = exitCode === 0 ? parseOs(stdout) : undefined;
    if (os !== undefined) cache.set(key, os);
    return os;
  };

  return async (projectId, profile, call, services) => {
    const at = now();
    // Best effort: a sandbox that cannot answer has no `os`.
    const os = await readOs(projectId, call, services).catch(() => undefined);
    return promptVariables({ profile, now: at, os });
  };
};
