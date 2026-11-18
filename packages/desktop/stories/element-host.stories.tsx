import type { Disposable, Ui } from 'bundle/contracts';
import { ElementHost } from 'desktop/ui/element-host';

/**
 * A `ui/v1` standing in for another bundle's elements: `create` answers a
 * labelled `<div>` naming the tag and its props, so a story shows where the
 * host places the element without loading that bundle.
 */
const ui: Ui = {
  define: (): Disposable => ({ dispose: () => undefined }),
  create: (tag, props) => {
    const node = document.createElement('div');
    node.dataset.created = tag;
    node.className =
      'flex flex-1 items-center justify-center rounded-md border border-dashed p-2 text-xs text-muted-foreground';
    node.textContent =
      props === undefined || Object.keys(props).length === 0
        ? `<${tag}>`
        : `<${tag}> ${JSON.stringify(props)}`;
    return node;
  },
  dispose: () => undefined,
};

export default {
  title: 'Desktop/Element host',
  component: ElementHost,
};

/** Another bundle's panel view, filling the host's parent. */
export const PanelView = {
  render: () => (
    <div className="flex h-80 w-80 flex-col bg-sidebar">
      <ElementHost
        ui={ui}
        tag="files-tree"
        props={{ label: 'Files', icon: 'files' }}
      />
    </div>
  ),
};

/** A badge element inside a bar. */
export const Badge = {
  render: () => (
    <div className="flex items-center gap-2 text-xs">
      Changes
      <ElementHost ui={ui} tag="git-changes-badge" />
    </div>
  ),
};

/** Another bundle's rows mounted under a Thread. */
export const ThreadRows = {
  render: () => (
    <div className="flex w-60 bg-sidebar py-1">
      <ElementHost
        ui={ui}
        tag="terminal-rows"
        props={{ 'thread-id': 'thread-plan' }}
      />
    </div>
  ),
};
