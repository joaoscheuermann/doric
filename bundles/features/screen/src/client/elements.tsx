// The screen client's elements, built inside a factory the activation calls,
// so importing this module touches no DOM global [D10-7]. Each renders in
// light DOM with `display: contents` and reads the activation's store, never
// an element's own state (D9-17).

import type { Services } from 'bundle/contracts';
import { Button } from 'desktop/ui/button';
import { defineReactElement } from 'desktop/ui/react-element';
import { MonitorIcon } from 'lucide-react';

import type { ScreenApi } from './api.js';
import { useService, useSubscribed } from './hooks.js';
import { ScreenPanels } from './panel/screen-panel.js';
import { LayoutWorkspaceV1, type ThreadRecord } from './peers.js';
import type { ScreenStore } from './store.js';

export const SCREEN_NEW_BUTTON_TAG = 'screen-new-button';
export const SCREEN_PANEL_TAG = 'screen-panel';

export interface ScreenClient {
  readonly api: ScreenApi;
  readonly store: ScreenStore;
}

const useSelectedThread = (services: Services): ThreadRecord | undefined => {
  const workspace = useService(services, LayoutWorkspaceV1);

  return useSubscribed(
    workspace,
    () =>
      (
        workspace as { selectedThread(): ThreadRecord | undefined }
      ).selectedThread(),
    undefined,
  );
};

export const defineScreenElements = (client: ScreenClient) => {
  const { store } = client;

  function NewScreenButton({ services }: { readonly services: Services }) {
    const thread = useSelectedThread(services);
    const projectId = thread?.projectId;

    return (
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 [app-region:no-drag]"
        aria-label="New screen"
        title="Open screen"
        disabled={projectId === undefined}
        onClick={
          projectId === undefined ? undefined : () => store.open(projectId)
        }
      >
        <MonitorIcon />
      </Button>
    );
  }

  function Panels({ services }: { readonly services: Services }) {
    const thread = useSelectedThread(services);

    return <ScreenPanels store={store} activeProjectId={thread?.projectId} />;
  }

  return {
    newButton: defineReactElement<object>({
      props: [],
      render: NewScreenButton,
    }),
    panel: defineReactElement<object>({
      props: [],
      render: Panels,
    }),
  };
};
