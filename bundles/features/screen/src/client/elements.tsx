// The screen client's elements: the sidebar's Screens pane. The layout draws the
// group's frame — its header, the collapse control and the resizable panel
// (`layout.stack/v1`) — so this part draws only what is inside it: one row per
// view of the current Project, and the header's add control in an element of its
// own. Clicking a row opens (or focuses) that view's window.
//
// Built inside a factory the activation calls, so importing this module touches
// no DOM global [D10-7], in light DOM and with no element-local state (D9-17):
// what it draws lives in the activation's mirror store.

import type { Services } from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import {
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarScope,
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
import { type LayoutWorkspace, LayoutWorkspaceV1 } from './peers.js';
import type { ScreenViewsStore } from './store.js';

export const SCREEN_SIDEBAR_TAG = 'screen-sidebar';

/** The Screens pane's header action: the control that opens another view. */
export const SCREEN_GROUP_ACTION_TAG = 'screen-group-action';

export interface ScreenClient {
  readonly store: ScreenViewsStore;
}

const NO_VIEWS: readonly ScreenView[] = Object.freeze([]);

/**
 * The Project of the current selection, read as the id the rows key on and the
 * reads below use.
 *
 * Every snapshot a subscribed read returns must keep its identity while nothing
 * changed: the layout builds a new selection record on every call, and a
 * snapshot whose identity changes on every read makes `useSyncExternalStore`
 * re-render without end (React's "Maximum update depth exceeded"). A field of a
 * record the layout rebuilds is a primitive, so it is what a read returns.
 */
const currentProjectIdOf = (
  workspace: LayoutWorkspace | undefined,
): string | undefined =>
  workspace === undefined ? undefined : workspace.selection().project?.id;

/**
 * The name of the selected Project while it is the Project a new view would
 * watch, else undefined: the selection is what knows a Project's name, and only
 * when it is that same Project.
 */
const projectLabelOf = (
  workspace: LayoutWorkspace | undefined,
  projectId: string | undefined,
): string | undefined => {
  if (workspace === undefined || projectId === undefined) return undefined;

  const { project } = workspace.selection();

  return project !== undefined && project.id === projectId
    ? project.name
    : undefined;
};

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
      {/* The row's own action, revealed on hover or focus like a Thread's own. */}
      <SidebarMenuAction
        showOnHover
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
    const projectId = useSubscribed(
      workspace,
      () => currentProjectIdOf(workspace),
      undefined,
    );
    // The pane lists the views of the Project the reader is looking at, never
    // another Project's: the group is the current Project's screens.
    const shown = views.filter((view) => view.projectId === projectId);

    return (
      // The element's root is its own: the sidebar's scope does not reach it
      // from the layout, so the pane brings one (as `git` and `files` do).
      <SidebarScope>
        <SidebarMenu className="w-full gap-0">
          {shown.map((view) => (
            <ScreenRow key={view.id} view={view} screens={screens} />
          ))}
        </SidebarMenu>
      </SidebarScope>
    );
  }

  function ScreenGroupAction({ services }: { readonly services: Services }) {
    const screens = useService(services, ScreenViewsV1);
    const workspace = useService(services, LayoutWorkspaceV1);
    const projectId = useSubscribed(
      workspace,
      () => currentProjectIdOf(workspace),
      undefined,
    );
    // The label names the Project the view watches, and only while the
    // selection is that same Project.
    const label = useSubscribed(
      workspace,
      () => projectLabelOf(workspace, projectId),
      undefined,
    );

    return (
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
    );
  }

  return {
    sidebar: defineReactElement<object>({
      props: [],
      render: ScreenSidebar,
    }),
    groupAction: defineReactElement<object>({
      props: [],
      render: ScreenGroupAction,
    }),
  };
};
