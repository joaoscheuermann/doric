import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from 'desktop/ui/resizable';

export default {
  title: 'desktop/ui/Resizable',
  component: ResizablePanelGroup,
};

const Pane = ({
  title,
  note,
}: {
  readonly title: string;
  readonly note: string;
}) => (
  <div className="flex h-full flex-col gap-1 p-3 text-sm">
    <span className="font-medium">{title}</span>
    <span className="text-muted-foreground">{note}</span>
  </div>
);

export const Horizontal = {
  render: () => (
    <div className="h-72 overflow-hidden rounded-lg border">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="30%" minSize="20%">
          <Pane title="Threads" note="5 Threads in doric" />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="70%">
          <Pane
            title="Add comment threads to papercraft previews"
            note="The conversation column"
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ),
};

export const Vertical = {
  render: () => (
    <div className="h-80 w-64 overflow-hidden rounded-lg border">
      <ResizablePanelGroup orientation="vertical">
        <ResizablePanel defaultSize="40%">
          <Pane title="Projects" note="doric, papermache, infra" />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="60%">
          <Pane title="Threads" note="The selected Project's Threads" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ),
};

export const WithHandle = {
  render: () => (
    <div className="h-72 overflow-hidden rounded-lg border">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="25%">
          <Pane title="Files" note="packages/desktop" />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="50%">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel defaultSize="65%">
              <Pane title="chrome-bar.tsx" note="Editor" />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="35%">
              <Pane title="Terminal" note="zsh — doric" />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="25%">
          <Pane title="Changes" note="3 files changed" />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ),
};
