import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  type LucideIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import * as React from 'react';

import { Button } from './components/button.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './components/collapsible.js';
import { toast } from './components/sonner.js';
import { describeError } from './error-copy.js';
import { cn } from './lib/utils.js';
import type { ErrorCatalog, ErrorInfo } from './reads/errors.js';

/** What a toast tells the notice it draws (§4); only `toastError` provides it. */
interface ToastContextValue {
  onDetailsChange(open: boolean): void;
}

const ToastContext = React.createContext<ToastContextValue | undefined>(
  undefined,
);

/** A failure toast's life while its details are closed (§4). */
const TOAST_DURATION_MS = 4000;

/** The number of the latest `toastError` call; each draws its surface with a new key. */
let toastCount = 0;

/** The render function each failure toast's id currently shows. */
const toastRenders = new Map<string, () => React.ReactElement>();

/** How long Copy details shows its outcome. */
const COPY_FEEDBACK_MS = 1500;

/** The most announcement keys a window remembers; the oldest leaves first. */
const MAX_ANNOUNCED = 200;

/** The keys of the failures this window has announced (§3.6). */
const announced = new Set<string>();

const rememberAnnounced = (key: string): void => {
  if (announced.has(key)) return;
  announced.add(key);
  for (const oldest of announced) {
    if (announced.size <= MAX_ANNOUNCED) break;
    announced.delete(oldest);
  }
};

/** The announcement key: code, message, `at` (absent as empty) and context. */
const announcementKey = (
  error: ErrorInfo,
  context: Readonly<Record<string, string>> | undefined,
): string =>
  JSON.stringify([
    error.code,
    error.message,
    error.at ?? '',
    Object.entries(context ?? {}),
  ]);

/** `text` with its further lines indented by two spaces. */
const indented = (text: string): string => text.split('\n').join('\n  ');

/** The details text of §3.4. */
const detailsText = (
  error: ErrorInfo,
  context: Readonly<Record<string, string>> | undefined,
): string => {
  const lines = [`Code: ${error.code === '' ? 'none' : error.code}`];
  if (error.provider !== undefined) lines.push(`Provider: ${error.provider}`);
  if (error.status !== undefined) lines.push(`Status: ${error.status}`);
  if (error.message !== '') lines.push(`Message: ${indented(error.message)}`);
  for (const cause of Array.isArray(error.causes) ? error.causes : []) {
    const origin = [cause.provider, cause.status].filter(
      (part) => part !== undefined,
    );
    lines.push(
      [
        'Caused by:',
        cause.code === undefined ? '' : `[${cause.code}]`,
        indented(cause.message),
        origin.length === 0 ? '' : `(${origin.join(', ')})`,
      ]
        .filter((part) => part !== '')
        .join(' '),
    );
  }
  for (const [label, value] of Object.entries(context ?? {})) {
    lines.push(`${label}: ${indented(value)}`);
  }
  if (error.at !== undefined) lines.push(`Time: ${error.at}`);
  return lines.join('\n');
};

type CopyState = 'idle' | 'copied' | 'failed';

const copyWords: Readonly<Record<CopyState, string>> = {
  idle: 'Copy details',
  copied: 'Copied',
  failed: 'Copy failed',
};

export interface ErrorNoticeProps {
  /** The failure to show; read as given, never mutated. */
  readonly error: ErrorInfo;
  /**
   * 'block' (default): a thin card, for transcript blocks and sections.
   * 'compact': no card, for rows and toasts. 'inline': no card and row 1 only
   * (no explanation, no Details link, no details), for one line inside a control.
   */
  readonly variant?: 'block' | 'compact' | 'inline';
  /**
   * Replaces the tone icon; drawn at the same size and in the tone's color.
   * Only the quarantine notice passes one (`PackageXIcon`, §7.2).
   */
  readonly icon?: LucideIcon;
  /** The bundle's error catalog, merged over the shared entries (§2.1). */
  readonly catalog?: ErrorCatalog;
  /** The entry used when no code in the chain has one (§2.3). */
  readonly fallbackCode?: string;
  /**
   * Labeled lines the details end with, in key order: `{ Thread: id, Prompt: id }`.
   * The quarantine notice puts one line per bundle here (§7.2).
   */
  readonly context?: Readonly<Record<string, string>>;
  /**
   * Shown as Retry only when D5 allows it: this is given, the headline entry
   * is retryable and the headline level does not say `retryable: false`.
   */
  readonly onRetry?: () => void;
  /** Disables Retry, spins its icon and marks it busy while the surface retries. */
  readonly retrying?: boolean;
  /** Announce the failure the first time this window shows it (§3.6). Default false. */
  readonly announce?: boolean;
  readonly className?: string;
}

/**
 * One failure, shown the same way on every surface: a tone icon, the error
 * catalog's title, Retry (only when D5 allows it) and Copy details on row 1;
 * the explanation and a Details link on row 2 (`block` and `compact`); the
 * details — code, provider, status, message, causes, context, time — in a
 * collapsible closed on first render.
 *
 * Accepts any `ErrorInfo`; never throws while rendering, so it needs no error
 * boundary. Never moves focus. Copy details writes the copy text (§3.4) to
 * the clipboard and reports "Copied" or "Copy failed" for 1 500 ms; a failed
 * copy throws nothing. With `announce`, the notice is `role="alert"` the
 * first time this window shows its key (code, message, `at`, context), else
 * `role="group"`.
 */
export function ErrorNotice({
  error,
  variant = 'block',
  icon,
  catalog,
  fallbackCode,
  context,
  onRetry,
  retrying = false,
  announce = false,
  className,
}: ErrorNoticeProps): React.JSX.Element {
  const toastContext = React.useContext(ToastContext);
  const id = React.useId();
  const titleId = `${id}-title`;
  const explanationId = `${id}-explanation`;

  const copy = describeError(error, { catalog, fallbackCode });
  const details = detailsText(error, context);
  const showsRows = variant !== 'inline';
  const showsExplanation = showsRows && copy.explanation.trim() !== '';
  const showsRetry = onRetry !== undefined && copy.retryable;
  const Glyph =
    icon ?? (copy.tone === 'warning' ? TriangleAlertIcon : CircleAlertIcon);

  // The role is decided at mount and when the key changes, without side
  // effects, so StrictMode's repeated render gives the same answer (§3.6).
  const key = announcementKey(error, context);
  const [announcement, setAnnouncement] = React.useState(() => ({
    key,
    fresh: !announced.has(key),
  }));
  let current = announcement;
  if (current.key !== key) {
    current = { key, fresh: !announced.has(key) };
    setAnnouncement(current);
  }
  React.useEffect(() => {
    if (announce) rememberAnnounced(key);
  }, [announce, key]);
  const alert = announce && current.fresh;

  const [open, setOpen] = React.useState(false);
  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    toastContext?.onDetailsChange(next);
  };

  const [copyState, setCopyState] = React.useState<CopyState>('idle');
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  React.useEffect(() => () => clearTimeout(copyTimer.current), []);
  const report = (state: CopyState): void => {
    setCopyState(state);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(
      () => setCopyState('idle'),
      COPY_FEEDBACK_MS,
    );
  };
  const onCopy = (): void => {
    const text = `${copy.title}\n${copy.explanation}\n\n${details}`;
    try {
      const clipboard = globalThis.navigator?.clipboard as
        | Clipboard
        | undefined;
      if (clipboard === undefined) {
        report('failed');
        return;
      }
      clipboard.writeText(text).then(
        () => report('copied'),
        () => report('failed'),
      );
    } catch {
      report('failed');
    }
  };
  const copyWord = copyWords[copyState];

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      data-slot="error-notice"
      data-variant={variant}
      data-tone={copy.tone}
      role={alert ? 'alert' : 'group'}
      aria-labelledby={titleId}
      aria-describedby={showsExplanation ? explanationId : undefined}
      className={cn(
        'flex flex-col gap-1 text-xs',
        variant === 'block' &&
          'rounded-md border border-border/70 bg-card/60 pt-1 pr-1 pb-2 pl-2.5',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'shrink-0 [&_svg]:size-3.5',
            copy.tone === 'warning' ? 'text-warning' : 'text-destructive',
          )}
        >
          <Glyph />
        </span>
        <span
          id={titleId}
          className="min-w-0 truncate text-foreground"
          title={copy.title}
        >
          {copy.title}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {showsRetry ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Retry"
              title="Retry"
              disabled={retrying}
              aria-busy={retrying ? true : undefined}
              onClick={() => {
                if (!retrying) onRetry();
              }}
            >
              <RotateCwIcon className={cn(retrying && 'animate-spin')} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={copyWord}
            title={copyWord}
            onClick={onCopy}
          >
            {copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
        <span
          className="sr-only"
          role={toastContext === undefined ? 'status' : undefined}
          aria-live={toastContext === undefined ? 'polite' : undefined}
        >
          {copyState === 'idle' ? '' : copyWord}
        </span>
      </div>
      {showsRows ? (
        <p className="-mt-0.5 pr-2 pl-5.5 leading-4 break-words text-muted-foreground">
          {showsExplanation ? (
            <span id={explanationId}>{copy.explanation}</span>
          ) : null}
          <CollapsibleTrigger
            type="button"
            className={cn(
              'text-muted-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-foreground',
              showsExplanation && 'ml-2.5',
            )}
          >
            {open ? 'Hide details' : 'Details'}
          </CollapsibleTrigger>
        </p>
      ) : null}
      {showsRows ? (
        <CollapsibleContent
          aria-live={toastContext === undefined ? undefined : 'off'}
          className="border-t border-border/60 pt-1.5 pb-1 pl-5.5"
        >
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the focusable scroll area needs a name when Tab lands on it (spec §3.3) */}
          <pre
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the details scroll on their own (max-h-40), so keyboard readers must reach them with Tab (spec §3.3, §3.6)
            tabIndex={0}
            aria-label="Error details"
            className="max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground select-text"
          >
            {details}
          </pre>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

export interface ToastErrorInput {
  /** Required: a later failure with the same id replaces this toast; no other toast uses it (§4). */
  readonly id: string;
  readonly error: ErrorInfo;
  /** As `ErrorNoticeProps.catalog`. */
  readonly catalog?: ErrorCatalog;
  /** As `ErrorNoticeProps.fallbackCode`. */
  readonly fallbackCode?: string;
  /** As `ErrorNoticeProps.context`. */
  readonly context?: Readonly<Record<string, string>>;
}

/**
 * Shows `input.error` as a toast: a `compact`, unannounced `ErrorNotice` with
 * the input's `error`, `catalog`, `fallbackCode` and `context`, and no Retry.
 *
 * The toast lives 4 000 ms (paused while the pointer is over the toaster or
 * the window is hidden) and does not expire while its details are open. A
 * later call with the same `id` replaces it in place, with a fresh notice
 * whose details are closed; toasts never stack per id. Needs the window's
 * `Toaster` (`desktop/ui/sonner`) mounted to be seen; returns nothing and
 * never throws.
 */
export const toastError = (input: ToastErrorInput): void => {
  toastCount += 1;
  const surfaceKey = toastCount;
  const { id } = input;
  const forget = (): void => {
    if (toastRenders.get(id) === render) toastRenders.delete(id);
  };
  const show = (duration: number): void => {
    toast.custom(render, {
      id,
      duration,
      onDismiss: forget,
      onAutoClose: forget,
    });
  };
  const context: ToastContextValue = {
    onDetailsChange: (open) => {
      if (toastRenders.get(id) === render) {
        show(open ? Number.POSITIVE_INFINITY : TOAST_DURATION_MS);
      }
    },
  };
  const render = (): React.ReactElement => (
    <div
      key={surfaceKey}
      data-slot="error-toast"
      className="w-[356px] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <ToastContext.Provider value={context}>
        <ErrorNotice
          variant="compact"
          error={input.error}
          catalog={input.catalog}
          fallbackCode={input.fallbackCode}
          context={input.context}
        />
      </ToastContext.Provider>
    </div>
  );
  toastRenders.set(id, render);
  show(TOAST_DURATION_MS);
};
