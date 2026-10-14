// The screen client's element: the sidebar's Screens group. It reads the
// desktop part's mirrored views and renders one row per view — the label and
// its status, a retry control when retrying can help and a way to remove it.
// Clicking a row opens (or focuses) that view's window.
//
// Built inside a factory the activation calls, so importing this module
// touches no DOM global [D10-7], in light DOM and with no element-local state
// (D9-17): what it draws lives in the activation's mirror store.

import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from 'desktop/ui/sidebar';
import {
  CircleAlertIcon,
  Loader2Icon,
  MonitorIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react';

import {
  type ScreenView,
  type ScreenViewStatus,
  type ScreenViews,
  ScreenViewsV1,
} from '../contracts/index.js';
import { useService, useSubscribed } from './hooks.js';
import {
  type LayoutWorkspace,
  LayoutWorkspaceV1,
  type WorkspaceSelection,
} from './peers.js';
import type { ScreenViewsStore } from './store.js';

export const SCREEN_SIDEBAR_TAG = 'screen-sidebar';

export interface ScreenClient {
  readonly store: ScreenViewsStore;
}

const NO_VIEWS: readonly ScreenView[] = Object.freeze([]);
const NO_SELECTION: WorkspaceSelection = Object.freeze({});

const selectedThreadOf = (workspace: LayoutWorkspace | undefined) =>
  workspace === undefined ? undefined : workspace.selectedThread();

const selectionOf = (
  workspace: LayoutWorkspace | undefined,
): WorkspaceSelection =>
  workspace === undefined ? NO_SELECTION : workspace.selection();

/**
 * What a status reads as in the row: its glyph, the one-line state and whether
 * the retry control can help. The retryable reasons are the desktop part's own
 * (`desktop/status.ts`): a waiting view is already being retried, an image
 * without xpra never gains one, and everything else may come back.
 */
const presentationOf = (
  status: ScreenViewStatus,
): {
  readonly Icon: typeof MonitorIcon;
  readonly text: string;
  readonly retry: boolean;
  readonly spin?: boolean;
} => {
  switch (status.kind) {
    case 'waiting':
      return { Icon: Loader2Icon, text: 'Starting…', retry: false, spin: true };
    case 'ready':
      return { Icon: MonitorIcon, text: status.display, retry: false };
    case 'failed':
      return {
        Icon: CircleAlertIcon,
        text: 'Backend unavailable',
        retry: true,
      };
    case 'unavailable':
      switch (status.reason) {
        case 'missing-xpra':
          return {
            Icon: CircleAlertIcon,
            text: 'No xpra in the image',
            retry: false,
          };
        case 'sandbox':
          return {
            Icon: CircleAlertIcon,
            text: 'Sandbox unavailable',
            retry: true,
          };
        case 'start-failed':
          return {
            Icon: CircleAlertIcon,
            text: 'Screen failed to start',
            retry: true,
          };
      }
  }
};

type Screens = ScreenViews | undefined;

function ScreenRow({
  view,
  screens,
}: {
  readonly view: ScreenView;
  readonly screens: Screens;
}) {
  const state = presentationOf(view.status);
  const { Icon } = state;
  const absent = screens === undefined;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        className="h-7 w-full translate-x-0 rounded-none pr-14"
        disabled={absent}
        title={`${view.label} — ${state.text}`}
        onClick={() => {
          void screens?.open(view.id).catch(() => undefined);
        }}
      >
        <Icon className={state.spin === true ? 'animate-spin' : undefined} />
        <span className="min-w-0 flex-1 truncate">{view.label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {state.text}
        </span>
      </SidebarMenuButton>
      {state.retry && (
        <SidebarMenuAction
          className="right-7"
          aria-label={`Retry ${view.label}`}
          title="Retry"
          disabled={absent}
          onClick={() => {
            void screens?.retry(view.id).catch(() => undefined);
          }}
        >
          <RotateCcwIcon />
        </SidebarMenuAction>
      )}
      <SidebarMenuAction
        aria-label={`Remove ${view.label}`}
        title="Remove view"
        disabled={absent}
        onClick={() => {
          void screens?.remove(view.id).catch(() => undefined);
        }}
      >
        <XIcon />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}

export const defineScreenElements = (client: ScreenClient) => {
  const { store } = client;

  function ScreenSidebar({ services }: { readonly services: Services }) {
    const views = useSubscribed(store, () => store.views(), NO_VIEWS);
    const screens = useService(services, ScreenViewsV1);
    const workspace = useService(services, LayoutWorkspaceV1);
    const thread = useSubscribed(
      workspace,
      () => selectedThreadOf(workspace),
      undefined,
    );
    const selection = useSubscribed(
      workspace,
      () => selectionOf(workspace),
      NO_SELECTION,
    );
    const projectId = thread?.projectId;
    // The label names the Project the view watches; the selection is what
    // knows a Project's name, and only when it is that same Project.
    const label =
      selection.project !== undefined && selection.project.id === projectId
        ? selection.project.name
        : undefined;

    return (
      <SidebarGroup className="p-0">
        <div className="group/group-label relative">
          <SidebarGroupLabel className="h-7 rounded-none px-3 text-xs font-normal">
            Screens
          </SidebarGroupLabel>
          <SidebarGroupAction
            className="top-1 right-1"
            aria-label="New screen view"
            title="Open the selected project's screen"
            disabled={projectId === undefined || screens === undefined}
            onClick={() => {
              if (projectId === undefined || screens === undefined) return;

              void screens
                .add(label === undefined ? { projectId } : { projectId, label })
                .catch(() => undefined);
            }}
          >
            <PlusIcon />
          </SidebarGroupAction>
        </div>
        <SidebarGroupContent className="w-full">
          <SidebarMenu className="w-full gap-0">
            {views.map((view) => (
              <ScreenRow key={view.id} view={view} screens={screens} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  return {
    sidebar: defineReactElement<object>({
      props: [],
      render: ScreenSidebar,
    }),
  };
};
