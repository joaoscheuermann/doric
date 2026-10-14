// The floating screen panel: a draggable, resizable, closable surface over
// the conversation area, rendering the Project's xpra HTML5 client in an
// iframe. One panel is mounted per Project the reader opened, so sibling
// Threads share it and a closed panel keeps its iframe alive until the
// window reloads.

import { Button } from 'desktop/ui/button';
import { Loader2Icon, MonitorIcon, RotateCcwIcon, XIcon } from 'lucide-react';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
} from 'react';

import type { ScreenUnavailableReason } from '../../contracts/index.js';
import { clampGeometry } from '../domain/geometry.js';
import { useSubscribed } from '../hooks.js';
import type { ScreenStatus, ScreenStore } from '../store.js';

const dragSetup = (element: HTMLElement | null) => {
  const parent = element?.offsetParent as HTMLElement | null | undefined;

  if (element === null || element === undefined || !parent) {
    return undefined;
  }

  const parentRect = parent.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  return {
    bounds: { width: parentRect.width, height: parentRect.height },
    origin: {
      x: elementRect.left - parentRect.left,
      y: elementRect.top - parentRect.top,
    },
    size: { width: elementRect.width, height: elementRect.height },
  };
};

/** Binds a pointer gesture to one captured element; returns its clean-up. */
const gesture = (
  target: HTMLElement,
  pointerId: number,
  move: (event: PointerEvent) => void,
): void => {
  target.setPointerCapture(pointerId);

  const done = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', done);
    target.removeEventListener('pointercancel', done);
  };

  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', done);
  target.addEventListener('pointercancel', done);
};

/** What one unavailable reason reads as, and whether retrying may help. */
const unavailableMessage = (
  reason: ScreenUnavailableReason,
): { readonly text: string; readonly retry: boolean } => {
  switch (reason) {
    case 'missing-xpra':
      return {
        text: 'This sandbox image has no xpra to serve a screen.',
        retry: false,
      };
    case 'sandbox':
      return { text: "The project's sandbox is unavailable.", retry: true };
    case 'start-failed':
      return { text: 'The screen could not start.', retry: true };
  }
};

const messageOf = (
  status: ScreenStatus,
): { readonly text: string; readonly retry: boolean } => {
  switch (status.kind) {
    case 'loading':
      return { text: "Connecting to the project's screen…", retry: false };
    case 'pending':
      return { text: "The project's sandbox is starting…", retry: false };
    case 'unavailable':
      return unavailableMessage(status.reason);
    case 'failed':
      return { text: 'Doric backend is unavailable.', retry: true };
    case 'ready':
      return { text: '', retry: false };
  }
};

function StatusMessage({
  projectId,
  status,
  store,
}: {
  readonly projectId: string;
  readonly status: ScreenStatus;
  readonly store: ScreenStore;
}) {
  const { text, retry } = messageOf(status);
  const waiting = status.kind === 'loading' || status.kind === 'pending';

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[var(--paper-text-base)] text-[var(--paper-gray-3)]">
      {waiting && <Loader2Icon className="size-4 animate-spin" />}
      <p className="m-0">{text}</p>
      {retry && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => store.retry(projectId)}
        >
          <RotateCcwIcon />
          Retry
        </Button>
      )}
    </div>
  );
}

function ScreenPanelView({
  store,
  projectId,
  active,
}: {
  readonly store: ScreenStore;
  readonly projectId: string;
  readonly active: boolean;
}) {
  const panel = useSubscribed(store, () => store.panel(projectId), undefined);
  const root = useRef<HTMLDivElement>(null);
  const hidden = panel === undefined || !panel.open || !active;

  // While the sandbox comes up — or the backend is down — the panel keeps
  // asking, so it comes up by itself once the session exists.
  const waiting =
    panel?.open === true &&
    active &&
    (panel?.status.kind === 'pending' || panel?.status.kind === 'failed');

  useEffect(() => {
    if (!waiting) {
      return undefined;
    }

    const timer = setInterval(() => store.retry(projectId), 2_000);

    return () => clearInterval(timer);
  }, [waiting, store, projectId]);

  // A screen that is up is still re-asked: the relay a panel embeds is the one
  // its host generation bound, so a restarted backend leaves the iframe asking
  // a port nothing answers. A fresh attach answers the current URL, and the
  // iframe reloads by itself when it changes.
  const live = panel?.open === true && active && panel?.status.kind === 'ready';

  useEffect(() => {
    if (!live) {
      return undefined;
    }

    const timer = setInterval(() => store.retry(projectId), 15_000);

    return () => clearInterval(timer);
  }, [live, store, projectId]);

  if (panel === undefined) {
    return null;
  }

  const style: CSSProperties =
    panel.geometry !== undefined
      ? {
          left: panel.geometry.x,
          top: panel.geometry.y,
          width: panel.geometry.width,
          height: panel.geometry.height,
          display: hidden ? 'none' : undefined,
        }
      : {
          right: 16,
          bottom: 16,
          width: 'min(40rem, calc(100% - 2rem))',
          height: 'min(25rem, calc(100% - 2rem))',
          display: hidden ? 'none' : undefined,
        };

  const onDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button') !== null) return;

    const setup = dragSetup(root.current);

    if (setup === undefined) return;

    const start = { x: event.clientX, y: event.clientY };
    const target = event.currentTarget;

    gesture(target, event.pointerId, (moved) => {
      store.setGeometry(
        projectId,
        clampGeometry(
          {
            x: setup.origin.x + (moved.clientX - start.x),
            y: setup.origin.y + (moved.clientY - start.y),
            width: setup.size.width,
            height: setup.size.height,
          },
          setup.bounds,
        ),
      );
    });
  };

  const onResizeStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;

    const setup = dragSetup(root.current);

    if (setup === undefined) return;

    const start = { x: event.clientX, y: event.clientY };
    const target = event.currentTarget;

    gesture(target, event.pointerId, (moved) => {
      store.setGeometry(
        projectId,
        clampGeometry(
          {
            x: setup.origin.x,
            y: setup.origin.y,
            width: setup.size.width + (moved.clientX - start.x),
            height: setup.size.height + (moved.clientY - start.y),
          },
          setup.bounds,
        ),
      );
    });
  };

  return (
    <div
      ref={root}
      data-slot="screen-panel"
      className="pointer-events-auto absolute z-20 flex flex-col overflow-hidden rounded-[var(--paper-radius-panel)] border border-[var(--paper-separator)] bg-[var(--paper-panel)] shadow-lg"
      style={style}
    >
      <div
        data-slot="screen-panel-header"
        className="flex h-9 shrink-0 cursor-grab touch-none select-none items-center gap-2 border-b border-[var(--paper-separator)] bg-[var(--paper-panel-highlight-1)] px-2 text-[var(--paper-text-base)] text-[var(--paper-gray-1)]"
        onPointerDown={onDragStart}
      >
        <MonitorIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">Screen</span>
        {panel.status.kind === 'ready' && (
          <span className="min-w-0 truncate text-[var(--paper-gray-3)]">
            {panel.status.display}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto shrink-0"
          aria-label="Close screen"
          title="Close screen"
          onClick={() => store.close(projectId)}
        >
          <XIcon />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-black">
        {panel.status.kind === 'ready' ? (
          <iframe
            title="Project screen"
            src={panel.status.url}
            className="h-full w-full border-0"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <StatusMessage
            projectId={projectId}
            status={panel.status}
            store={store}
          />
        )}
      </div>
      <div
        aria-hidden="true"
        className="absolute right-0 bottom-0 size-3 cursor-nwse-resize touch-none"
        onPointerDown={onResizeStart}
      />
    </div>
  );
}

/** Every mounted Project panel; the selected Project's is the visible one. */
export function ScreenPanels({
  store,
  activeProjectId,
}: {
  readonly store: ScreenStore;
  readonly activeProjectId?: string;
}) {
  const projects = useSubscribed(store, () => store.mounted(), []);

  return (
    <>
      {projects.map((projectId) => (
        <ScreenPanelView
          key={projectId}
          store={store}
          projectId={projectId}
          active={projectId === activeProjectId}
        />
      ))}
    </>
  );
}
