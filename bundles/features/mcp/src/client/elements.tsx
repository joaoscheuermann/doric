// The MCP client's elements: the sidebar's MCP pane. The layout draws the
// group's frame — its header, the collapse control and its 40% cap
// (`layout.stack/v2`) — so this part draws only what is inside it: one
// one-line row per server of the selected Project, as the Screens pane draws
// its views, with its tool count once connected and its status otherwise, and
// the header's add control in an element of its own. A row opens the server's
// dialog; its actions sign in to it and remove it. A watch that failed says so
// in an alert; a loaded pane with no servers says so.
//
// Built inside a factory the activation calls, so importing this module touches
// no DOM global [D10-7]. What the rows show lives in the activation's store
// (D9-17), and so do the sign-ins under way (`sign-in.ts`); an element keeps
// only which of its dialogs is open.

import { Alert, AlertDescription, AlertTitle } from 'desktop/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from 'desktop/ui/alert-dialog';
import { Button } from 'desktop/ui/button';
import { defineReactElement } from 'desktop/ui/react-element';
import {
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarScope,
} from 'desktop/ui/sidebar';
import { toast } from 'desktop/ui/sonner';
import { cn } from 'desktop/ui/utils';
import {
  BadgeAlertIcon,
  BadgeCheckIcon,
  BadgeIcon,
  BadgeInfoIcon,
  BadgeMinusIcon,
  BadgeXIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';

import type { McpServerView, McpStatus } from '../contracts/index.js';
import { failureMessage, type McpApi } from './api.js';
import { useSubscribed } from './hooks.js';
import { McpLogo } from './mcp-logo.js';
import { ServerDialog } from './server-dialog.js';
import type { McpSignIns } from './sign-in.js';
import type { McpServersStore } from './store.js';

export const MCP_SIDEBAR_TAG = 'mcp-sidebar';

/** The MCP pane's header action: the control that adds a server. */
export const MCP_GROUP_ACTION_TAG = 'mcp-group-action';

interface McpClient {
  readonly store: McpServersStore;
  readonly api: McpApi;
  readonly signIns: McpSignIns;
}

/** Placeholder rows while the selected Project's watch has not answered yet. */
const SKELETON_ROWS = ['mcp-skeleton-0', 'mcp-skeleton-1', 'mcp-skeleton-2'];

/**
 * What each status reads as in a row, its glyph and the glyph's tone: one
 * badge family, `badge-check` when connected, muted while the server does
 * nothing, red when it failed (spec §9.5, chosen on 2026-11-11).
 */
const statusOf: Readonly<
  Record<
    McpStatus,
    {
      readonly label: string;
      readonly Icon: typeof BadgeCheckIcon;
      readonly tone?: string;
    }
  >
> = {
  disabled: {
    label: 'Disabled',
    Icon: BadgeMinusIcon,
    tone: 'text-muted-foreground',
  },
  idle: { label: 'Idle', Icon: BadgeIcon, tone: 'text-muted-foreground' },
  connecting: { label: 'Connecting…', Icon: LoaderCircleIcon },
  connected: { label: 'Connected', Icon: BadgeCheckIcon },
  'needs-sign-in': { label: 'Sign in required', Icon: BadgeAlertIcon },
  'waiting-for-sandbox': {
    label: 'Waiting for sandbox',
    Icon: BadgeInfoIcon,
    tone: 'text-muted-foreground',
  },
  error: { label: 'Error', Icon: BadgeXIcon, tone: 'text-destructive' },
};

const toolCount = (count: number): string =>
  count === 1 ? '1 tool' : `${count} tools`;

/** Only an http server the host asked to sign in offers it. */
const offersSignIn = (server: McpServerView): boolean =>
  server.transport.kind === 'http' && server.status.state === 'needs-sign-in';

/**
 * A pane row's states, on its menu item (docs/designs/sidebar-alignment.md
 * §11.6): the accent mixed in at 50% under the pointer and 80% while pressed,
 * and an inset ring while its button has keyboard focus.
 */
const ROW_STATES =
  'rounded-[4px] hover:bg-[color-mix(in_oklch,var(--sidebar-accent)_50%,var(--sidebar))] active:bg-[color-mix(in_oklch,var(--sidebar-accent)_80%,var(--sidebar))] has-[[data-slot=sidebar-menu-button]:focus-visible]:ring-2 has-[[data-slot=sidebar-menu-button]:focus-visible]:ring-inset has-[[data-slot=sidebar-menu-button]:focus-visible]:ring-sidebar-ring';

/** The row's button draws no fill and no ring: its menu item draws both. */
const NO_FILL_BUTTON =
  'bg-transparent hover:bg-transparent active:bg-transparent data-active:bg-transparent focus-visible:ring-0';

/** The Thread row's hover or keyboard-focus reveal (`row-add-action.tsx`), on the menu item. */
const ON_HOVER =
  'pointer-events-none opacity-0 after:inset-0 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 group-has-[:focus-visible]/menu-item:pointer-events-auto group-has-[:focus-visible]/menu-item:opacity-100';

/** The open pane's notice when it has no rows, on the rows' icon column. */
function EmptyRow({ text }: { readonly text: string }) {
  return (
    <p className="flex h-7 items-center px-1.5 text-xs text-muted-foreground">
      {text}
    </p>
  );
}

function ServerRow({
  server,
  signingIn,
  onEdit,
  onSignIn,
  onRemove,
}: {
  readonly server: McpServerView;
  readonly signingIn: boolean;
  readonly onEdit: () => void;
  readonly onSignIn: () => void;
  readonly onRemove: () => void;
}) {
  const { state, message } = server.status;
  const { label, Icon, tone } = statusOf[state];
  const signs = offersSignIn(server);

  return (
    <SidebarMenuItem className={ROW_STATES}>
      <SidebarMenuButton
        size="sm"
        className={`h-7 w-full translate-x-0 rounded-[4px] pr-2.5 pl-1.5 group-has-data-[sidebar=menu-action]/menu-item:pr-2.5 ${NO_FILL_BUTTON}`}
        title={[server.name, label, message].filter(Boolean).join(' — ')}
        onClick={onEdit}
      >
        <Icon className={cn(tone, state === 'connecting' && 'animate-spin')} />
        <span className="min-w-0 flex-1 truncate">{server.name}</span>
        {!signs && (
          <span className="shrink-0 text-xs text-muted-foreground group-has-[:focus-visible]/menu-item:opacity-0 group-hover/menu-item:opacity-0">
            {state === 'connected' ? toolCount(server.tools.length) : label}
          </span>
        )}
      </SidebarMenuButton>
      {signs && (
        // The status text is the action, always shown and read as a link; a
        // button cannot sit inside the row's, so it sits over the row's right
        // edge and steps left on hover or keyboard focus to make room for the
        // remove action.
        <button
          type="button"
          className="absolute top-1 right-1.5 flex h-5 items-center gap-0.5 rounded-md px-1 text-xs text-sidebar-foreground underline decoration-sidebar-foreground/40 underline-offset-2 ring-sidebar-ring outline-hidden hover:decoration-sidebar-foreground focus-visible:ring-2 disabled:opacity-50 group-has-[:focus-visible]/menu-item:right-7 group-hover/menu-item:right-7 [&>svg]:size-3 [&>svg]:shrink-0"
          aria-label={`Sign in to ${server.name}`}
          title="Sign in (opens in your browser)"
          disabled={signingIn}
          onClick={onSignIn}
        >
          Sign in
          <ExternalLinkIcon aria-hidden />
        </button>
      )}
      {/* Laid over the status on hover or focus, like a Thread row's own. */}
      <SidebarMenuAction
        type="button"
        className={`right-1 ${ON_HOVER}`}
        style={{ top: '0.25rem' }}
        aria-label={`Remove ${server.name}`}
        title="Remove"
        onClick={onRemove}
      >
        <XIcon />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}

function RemoveDialog({
  server,
  onConfirm,
  onClose,
}: {
  readonly server: McpServerView;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <McpLogo className="size-4 shrink-0" />
            Remove {server.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Its tools leave this Project's prompts, and the tokens its sign-in
            stored are deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onConfirm}>
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export const defineMcpElements = ({ store, api, signIns }: McpClient) => {
  function McpSidebar() {
    const projectId = useSubscribed(store, () => store.projectId());
    const servers = useSubscribed(store, () => store.servers());
    const loaded = useSubscribed(store, () => store.loaded());
    const failure = useSubscribed(store, () => store.failure());
    const signingIn = useSubscribed(store, () => store.signingIn());
    const [editing, setEditing] = useState<McpServerView>();
    const [removing, setRemoving] = useState<McpServerView>();

    const remove = async (server: McpServerView): Promise<void> => {
      setRemoving(undefined);
      try {
        await api.remove(server.projectId, server.id);
      } catch (error) {
        toast.error(failureMessage(error), { id: 'mcp-server-remove' });
      }
    };

    // Until the Project's watch answers, its servers are unknown, not none.
    const loading = projectId !== undefined && !loaded;

    return (
      // The element's root is its own: the sidebar's scope does not reach it
      // from the layout, so the pane brings one (as `screen` does).
      <SidebarScope>
        {failure !== undefined && (
          <Alert variant="destructive" className="mx-2 mb-2 w-auto">
            <CircleAlertIcon />
            <AlertTitle>Unable to load MCP servers</AlertTitle>
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <SidebarMenu className="w-full gap-0" aria-busy={loading || undefined}>
          {loading &&
            SKELETON_ROWS.map((row) => (
              <SidebarMenuItem key={row}>
                <SidebarMenuSkeleton
                  showIcon
                  className="h-7 rounded-[4px] pl-1.5 pr-2.5"
                />
              </SidebarMenuItem>
            ))}
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              signingIn={signingIn.has(server.id)}
              onEdit={() => setEditing(server)}
              onSignIn={() => signIns.start(server)}
              onRemove={() => setRemoving(server)}
            />
          ))}
        </SidebarMenu>
        {loaded && failure === undefined && servers.length === 0 && (
          <EmptyRow text="No MCP servers" />
        )}
        {editing !== undefined && (
          <ServerDialog
            api={api}
            projectId={editing.projectId}
            server={editing}
            onClose={() => setEditing(undefined)}
          />
        )}
        {removing !== undefined && (
          <RemoveDialog
            server={removing}
            onConfirm={() => void remove(removing)}
            onClose={() => setRemoving(undefined)}
          />
        )}
      </SidebarScope>
    );
  }

  function McpGroupAction() {
    const projectId = useSubscribed(store, () => store.projectId());
    /** The Project the open dialog adds to, fixed when it opened. */
    const [addingTo, setAddingTo] = useState<string>();

    return (
      <>
        <SidebarGroupAction
          className="top-1 right-1"
          aria-label="Add MCP server"
          title="Add MCP server"
          disabled={projectId === undefined}
          onClick={() => setAddingTo(projectId)}
        >
          <PlusIcon />
        </SidebarGroupAction>
        {addingTo !== undefined && (
          <ServerDialog
            api={api}
            projectId={addingTo}
            onClose={() => setAddingTo(undefined)}
          />
        )}
      </>
    );
  }

  return {
    sidebar: defineReactElement<object>({
      props: [],
      render: McpSidebar,
    }),
    groupAction: defineReactElement<object>({
      props: [],
      render: McpGroupAction,
    }),
  };
};
