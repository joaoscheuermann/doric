/**
 * The prompt lifecycle as the conversation states it.
 *
 * An interruption leaves two events in a Thread's log — a `prompt.paused` that
 * says why the prompt was left unfinished, and the `prompt.resumed` that queued
 * its recovery. The projector only displays a resume after an `agent.started`
 * confirms a previously started prompt is executing again. A prompt the host
 * gives up on is closed as a failure carrying a
 * code. The vocabulary is the host's; this module only says how each one reads:
 * the icon and the line of the row it wears, whether that row offers the reader
 * the action to take the prompt up again, and whether a failure code is the one
 * that has to be answered rather than merely read.
 */

/** Why an interruption left a prompt unfinished. */
export type PauseReason = 'host_stopped' | 'host_restarted' | 'reader_stopped';

/**
 * One lifecycle event of a prompt: a pause that left it unfinished, or a resume
 * the host took it up with.
 */
export type LifecycleEvent =
  | {
      readonly kind: 'pause';
      readonly reason: PauseReason;
      /** When the pause was written; the row names the hour of a host stop. */
      readonly at: string;
      /**
       * Whether the pause still stands — nothing has taken the prompt up or
       * finished it since — which is what the row's action is offered on.
       */
      readonly standing: boolean;
    }
  | {
      readonly kind: 'resume';
      readonly attempt: number;
      readonly pause?: { readonly reason: PauseReason; readonly at: string };
    };

/** The icon a lifecycle row wears. */
export type LifecycleIcon = 'pause' | 'play';

/** How one lifecycle event reads: its icon, its line, and its action. */
export type LifecycleMarker = {
  readonly icon: LifecycleIcon;
  readonly label: string;
  readonly tooltip?: string;
  /** Whether the row offers the reader the Resume action. */
  readonly action: boolean;
};

/** The failure a prompt the host gave up on is closed with. */
export type PromptFailure = {
  readonly name: string;
  readonly code: string;
  readonly message: string;
};

/** The code a prompt the host stopped taking up again carries. */
export const RESUME_EXHAUSTED = 'resume_exhausted';

/**
 * The pause reason a `prompt.paused` carries, or `undefined` when it names none:
 * a reason this vocabulary does not know reads as no pause rather than as a
 * guess.
 */
export const pauseReason = (value: unknown): PauseReason | undefined =>
  value === 'host_stopped' ||
  value === 'host_restarted' ||
  value === 'reader_stopped'
    ? value
    : undefined;

/** The attempt a `prompt.resumed` opens, or `undefined` when it names none. */
export const resumeAttempt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;

/** A time as `HH:MM` in the reader's own zone; empty when it cannot be read. */
const clock = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

/** What each reason says about how the prompt was interrupted. */
const reasonText = (reason: PauseReason, at: string): string => {
  switch (reason) {
    case 'host_stopped':
      return at === ''
        ? 'Execution paused · the host stopped'
        : `Execution paused · the host stopped at ${at}`;
    case 'host_restarted':
      return 'Execution paused · the host restarted unexpectedly';
    case 'reader_stopped':
      return 'Execution paused · you stopped the execution';
  }
};

/**
 * How one lifecycle event reads. A pause is a quiet row naming what interrupted
 * the prompt; while it still stands the row offers the reader the action to take
 * the prompt up again — theirs alone after their own stop, and theirs to hurry
 * along before a host takes its own interruption up. A resume names the attempt
 * the host opened, and asks nothing of the reader.
 */
export const lifecycleMarker = (event: LifecycleEvent): LifecycleMarker => {
  if (event.kind === 'resume')
    return {
      action: false,
      icon: 'play',
      label: `Execution resumed · attempt ${event.attempt}`,
      ...(event.pause
        ? { tooltip: reasonText(event.pause.reason, clock(event.pause.at)) }
        : {}),
    };
  return {
    action: event.standing,
    icon: 'pause',
    label: reasonText(event.reason, clock(event.at)),
  };
};

/** The failure an `agent.failed` carries, read into the shape a block renders. */
export const promptFailure = (value: unknown): PromptFailure => {
  if (typeof value === 'string') return { code: '', message: value, name: '' };
  if (typeof value !== 'object' || value === null)
    return { code: '', message: '', name: '' };
  const fields = value as Readonly<Record<string, unknown>>;
  const text = (key: string): string => {
    const field = fields[key];
    return typeof field === 'string' ? field : '';
  };
  return { code: text('code'), message: text('message'), name: text('name') };
};

/** Whether a failure carries anything to say for itself. */
export const statesFailure = (failure: PromptFailure): boolean =>
  failure.code !== '' || failure.message !== '';

/**
 * Whether a failure code is the exhausted-resume one. That failure is the one
 * that is not quiet — the prompt's attempts ran out and only the reader can
 * decide what happens next — so it reads as a warning rather than as an ordinary
 * failure.
 */
export const resumeExhausted = (code: string | undefined): boolean =>
  code === RESUME_EXHAUSTED;
