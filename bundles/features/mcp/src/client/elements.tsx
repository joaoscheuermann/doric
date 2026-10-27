// The MCP client's elements: the sidebar's MCP pane. The layout draws the
// group's frame — its header, the collapse control and the resizable panel
// (`layout.stack/v1`) — so this part draws only what is inside it: one row per
// server of the selected Project, with its status and tool count, and the
// header's add control in an element of its own. A row opens the server's
// dialog; its actions sign in to it and remove it.
//
// Built inside a factory the activation calls, so importing this module touches
// no DOM global [D10-7]. What the rows show lives in the activation's store
// (D9-17); an element keeps only which of its dialogs is open.

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
import { Empty, EmptyDescription, EmptyHeader } from 'desktop/ui/empty';
import { defineReactElement } from 'desktop/ui/react-element';
import {
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarScope,
} from 'desktop/ui/sidebar';
import { toast } from 'desktop/ui/sonner';
import { cn } from 'desktop/ui/utils';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleOffIcon,
  HourglassIcon,
  KeyRoundIcon,
  Loader2Icon,
  LogInIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';

import type { McpServerView, McpStatus } from '../contracts/index.js';
import { failureMessage, type McpApi } from './api.js';
import { useSubscribed } from './hooks.js';
import { ServerDialog } from './server-dialog.js';
import type { McpServersStore } from './store.js';

export const MCP_SIDEBAR_TAG = 'mcp-sidebar';

/** The MCP pane's header action: the control that adds a server. */
export const MCP_GROUP_ACTION_TAG = 'mcp-group-action';

interface McpClient {
  readonly store: McpServersStore;
  readonly api: McpApi;
}

/** What each status reads as in a row, and its glyph. */
const statusOf: Readonly<
  Record<
    McpStatus,
    { readonly label: string; readonly Icon: typeof CircleCheckIcon }
  >
> = {
  disabled: { label: 'Disabled', Icon: CircleOffIcon },
  idle: { label: 'Idle', Icon: CircleDashedIcon },
  connecting: { label: 'Connecting…', Icon: Loader2Icon },
  connected: { label: 'Connected', Icon: CircleCheckIcon },
  'needs-sign-in': { label: 'Sign in required', Icon: KeyRoundIcon },
  'waiting-for-sandbox': { label: 'Waiting for sandbox', Icon: HourglassIcon },
  error: { label: 'Error', Icon: CircleAlertIcon },
};

const toolCount = (count: number): string =>
  count === 1 ? '1 tool' : `${count} tools`;

/** Only an http server the host asked to sign in offers it. */
const offersSignIn = (server: McpServerView): boolean =>
  server.transport.kind === 'http' && server.status.state === 'needs-sign-in';

/**
 * Signs in to an http server: the host prepares the authorization, the system
 * browser opens it, and the host waits for its answer. A browser that did not
 * open leaves the URL in a toast, so the sign-in is one click away.
 */
const signIn = async (api: McpApi, server: McpServerView): Promise<void> => {
  const id = `mcp-sign-in-${server.id}`;
  try {
    const url = await api.signIn(server.projectId, server.id);
    await api.openBrowser(url).catch(() => {
      toast.info(`Open ${url} in a browser to sign in to ${server.name}.`, {
        id,
      });
    });
    await api.finishSignIn(server.projectId, server.id);
  } catch (error) {
    toast.error(failureMessage(error), { id });
  }
};

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
  const { label, Icon } = statusOf[server.status.state];
  const { message } = server.status;
  const signs = offersSignIn(server);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        className={cn(
          'h-11 w-full translate-x-0 rounded-none pl-3',
          signs ? 'pr-20' : 'pr-14',
        )}
        title={
          message === undefined ? server.name : `${server.name} — ${message}`
        }
        onClick={onEdit}
      >
        <Icon
          className={cn(
            server.status.state === 'connecting' && 'animate-spin',
            server.status.state === 'error' && 'text-destructive',
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{server.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {label} · {toolCount(server.tools.length)}
            {message === undefined ? null : ` · ${message}`}
          </span>
        </span>
      </SidebarMenuButton>
      {signs && (
        <SidebarMenuAction
          className="top-3 right-13"
          aria-label={`Sign in to ${server.name}`}
          title="Sign in"
          disabled={signingIn}
          onClick={onSignIn}
        >
          <LogInIcon />
        </SidebarMenuAction>
      )}
      <SidebarMenuAction
        showOnHover
        className="top-3 right-7"
        aria-label={`Edit ${server.name}`}
        title="Edit"
        onClick={onEdit}
      >
        <PencilIcon />
      </SidebarMenuAction>
      <SidebarMenuAction
        showOnHover
        className="top-3"
        aria-label={`Remove ${server.name}`}
        title="Remove"
        onClick={onRemove}
      >
        <Trash2Icon />
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
          <AlertDialogTitle>Remove {server.name}?</AlertDialogTitle>
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

export const defineMcpElements = ({ store, api }: McpClient) => {
  function McpSidebar() {
    const projectId = useSubscribed(store, () => store.projectId());
    const servers = useSubscribed(store, () => store.servers());
    const failure = useSubscribed(store, () => store.failure());
    const [editing, setEditing] = useState<McpServerView>();
    const [removing, setRemoving] = useState<McpServerView>();
    const [signingIn, setSigningIn] = useState<ReadonlySet<string>>(new Set());

    const startSignIn = (server: McpServerView): void => {
      setSigningIn((ids) => new Set(ids).add(server.id));
      void signIn(api, server).finally(() =>
        setSigningIn((ids) => {
          const next = new Set(ids);
          next.delete(server.id);
          return next;
        }),
      );
    };

    const remove = async (server: McpServerView): Promise<void> => {
      setRemoving(undefined);
      try {
        await api.remove(server.projectId, server.id);
      } catch (error) {
        toast.error(failureMessage(error), { id: 'mcp-server-remove' });
      }
    };

    const notice =
      projectId === undefined
        ? 'Select a project to see its MCP servers.'
        : (failure ??
          (servers.length === 0
            ? 'No MCP servers in this project.'
            : undefined));

    return (
      // The element's root is its own: the sidebar's scope does not reach it
      // from the layout, so the pane brings one (as `screen` does).
      <SidebarScope>
        {notice !== undefined && (
          <Empty className="gap-2 p-3">
            <EmptyHeader>
              <EmptyDescription className="text-xs">{notice}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <SidebarMenu className="w-full gap-0">
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              signingIn={signingIn.has(server.id)}
              onEdit={() => setEditing(server)}
              onSignIn={() => startSignIn(server)}
              onRemove={() => setRemoving(server)}
            />
          ))}
        </SidebarMenu>
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
          title="Add an MCP server to the selected project"
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
