import type { ErrorCatalog, ErrorInfo } from 'desktop/reads';
import { Button } from 'desktop/ui/button';
import { ErrorNotice, toastError } from 'desktop/ui/error-notice';
import { Toaster } from 'desktop/ui/sonner';
import { FileTextIcon, PackageXIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

export default {
  title: 'desktop/ui/Error notice',
  component: ErrorNotice,
};

/*
 * The look of spec `docs/designs/error-messages.md` §3.3: every variant, both
 * tones, Retry and its spinning state, the open details, the toast surface,
 * and the places the windows draw a notice.
 */

const at = '2026-11-16T12:00:00.000Z';

const rateLimited: ErrorInfo = {
  code: 'internal',
  message: 'The model request failed.',
  causes: [
    {
      code: 'rate_limit_error',
      provider: 'anthropic',
      status: 429,
      retryable: true,
      message: 'Too many requests.',
    },
    { message: 'socket hang up' },
  ],
  at,
};

const notFound: ErrorInfo = {
  code: 'not_found',
  message: 'No such file: src/client/domain/error-catalog.ts',
  causes: [],
  at,
};

const resumeCatalog: ErrorCatalog = {
  resume_exhausted: {
    title: 'Execution stopped',
    explanation: 'The host restarted three times while the run was going.',
    retryable: true,
    tone: 'warning',
  },
};

const resumeExhausted: ErrorInfo = {
  code: 'resume_exhausted',
  message: 'Resume attempts exhausted.',
  causes: [],
  at,
};

/** A notice in a box as wide as a transcript column. */
const Column = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex w-[420px] flex-col gap-3">{children}</div>
);

/** Opens the details of the notices inside it once, after mount. */
const OpenDetails = ({ children }: { readonly children: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const button of ref.current?.querySelectorAll('button') ?? []) {
      if (button.textContent?.trim() === 'Details') button.click();
    }
  }, []);
  return <div ref={ref}>{children}</div>;
};

export const Variants = {
  render: () => (
    <Column>
      <ErrorNotice error={rateLimited} onRetry={() => undefined} />
      <ErrorNotice error={notFound} variant="compact" />
      <ErrorNotice error={notFound} variant="inline" />
    </Column>
  ),
};

export const Tones = {
  render: () => (
    <Column>
      <ErrorNotice error={notFound} />
      <ErrorNotice
        error={resumeExhausted}
        catalog={resumeCatalog}
        onRetry={() => undefined}
      />
    </Column>
  ),
};

export const Retry = {
  render: () => (
    <Column>
      <ErrorNotice error={rateLimited} />
      <ErrorNotice error={rateLimited} onRetry={() => undefined} />
      <ErrorNotice error={rateLimited} onRetry={() => undefined} retrying />
    </Column>
  ),
};

export const DetailsOpen = {
  render: () => (
    <Column>
      <OpenDetails>
        <ErrorNotice
          error={rateLimited}
          context={{ Thread: 'thread-1', Prompt: 'prompt-2' }}
          onRetry={() => undefined}
        />
      </OpenDetails>
    </Column>
  ),
};

export const LongTexts = {
  render: () => (
    <div className="flex w-[280px] flex-col gap-3">
      <ErrorNotice
        error={{ code: 'long_title', message: 'Short.', causes: [], at }}
        catalog={{
          long_title: {
            title: 'A title long enough that the ellipsis cuts it on one line',
            retryable: true,
          },
        }}
        onRetry={() => undefined}
      />
      <ErrorNotice
        error={{
          code: 'invalid_input',
          message:
            'The request names a workspace folder that no longer exists on this machine, so the host refused it before reading anything.',
          causes: [],
          at,
        }}
      />
      <ErrorNotice
        error={{ code: 'blank', message: 'Unused.', causes: [], at }}
        catalog={{
          blank: {
            title: 'No explanation',
            explanation: ' ',
            retryable: false,
          },
        }}
      />
    </div>
  ),
};

export const InToolRow = {
  render: () => (
    <Column>
      <div className="flex flex-col gap-1 rounded-md border px-2.5 py-2 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <FileTextIcon className="size-3.5" />
          <span>read_file src/client/domain/error-catalog.ts</span>
        </div>
        <ErrorNotice error={notFound} variant="compact" />
      </div>
    </Column>
  ),
};

export const InFooterPicker = {
  render: () => (
    <div className="flex w-[360px] items-center gap-2 rounded-md border px-2 py-1">
      <span className="shrink-0 text-xs text-muted-foreground">Execution</span>
      <ErrorNotice
        error={{
          code: 'unavailable',
          message: 'Host gone.',
          causes: [],
          at,
        }}
        variant="inline"
        onRetry={() => undefined}
        className="min-w-0 flex-1"
      />
    </div>
  ),
};

export const QuarantineInSidebar = {
  render: () => (
    <div className="flex h-[360px] w-[260px] flex-col border-r bg-sidebar">
      <div className="flex-1 p-2 text-xs text-muted-foreground">
        The sidebar's content keeps its layout above the notice.
      </div>
      <OpenDetails>
        <ErrorNotice
          className="mx-1.5 mb-1.5 shrink-0"
          error={{ code: 'bundle_quarantined', message: '', causes: [] }}
          catalog={{
            bundle_quarantined: {
              title: '2 bundles stopped',
              explanation: 'Their views stay empty until they load again.',
              retryable: false,
              tone: 'warning',
            },
          }}
          icon={PackageXIcon}
          context={{
            chat: 'Crashed 3 times while starting.',
            settings: 'Requires doric ^1.8.0.',
          }}
        />
      </OpenDetails>
    </div>
  ),
};

/** The toast surface of §4: the window's Toaster with one failure toast. */
const showToast = (): void =>
  toastError({
    id: 'story-error-toast',
    error: { ...notFound, at: new Date().toISOString() },
    context: { Thread: 'thread-1' },
  });

const ToastDemo = () => {
  useEffect(showToast, []);
  return (
    <div className="flex h-[240px] items-start">
      <Button variant="outline" size="sm" onClick={showToast}>
        Show the toast again
      </Button>
      <Toaster />
    </div>
  );
};

export const ToastSurface = {
  render: () => <ToastDemo />,
};
