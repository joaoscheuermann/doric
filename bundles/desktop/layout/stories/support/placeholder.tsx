// Labelled stand-ins for the elements other bundles put in the layout's slots
// (`ui/v1` elements, region items, the conversation outlet). The layout only
// hosts them, so a story shows where each one lands and who draws it instead
// of mounting another bundle. The DOM version is what the fake `ui/v1`
// returns; the React version fills a slot a story passes as a prop.

import type { CSSProperties } from 'react';

/** What a stand-in says: what the element is and which bundle draws it. */
export interface ElementInfo {
  readonly label: string;
  readonly owner: string;
  /** `inline` sits in a bar, `row` in the sidebar tree, `block` fills a slot. */
  readonly shape: 'inline' | 'row' | 'block';
}

/** The elements the running app mounts in the layout, by tag. */
export const elementInfo: Readonly<Record<string, ElementInfo>> = {
  'files-tree': { label: 'Files', owner: 'files', shape: 'block' },
  'files-viewer': { label: 'File viewer', owner: 'files', shape: 'block' },
  'git-changes': { label: 'Changes', owner: 'git', shape: 'block' },
  'git-changes-badge': { label: '3', owner: 'git', shape: 'inline' },
  'git-diff-viewer': { label: 'Diff viewer', owner: 'git', shape: 'block' },
  'git-workspace-cwd': {
    label: '~/workspace · main',
    owner: 'git',
    shape: 'inline',
  },
  'usage-summary': {
    label: '18.2k tokens · $0.21',
    owner: 'usage',
    shape: 'inline',
  },
  'resources-monitor': {
    label: 'CPU 14% · RAM 3.2 GB',
    owner: 'resources',
    shape: 'inline',
  },
  'terminal-new-button': {
    label: 'New terminal',
    owner: 'terminal',
    shape: 'inline',
  },
  'terminal-rows': {
    label: 'Terminal · npm run dev',
    owner: 'terminal',
    shape: 'row',
  },
  'terminal-panel': { label: 'Terminals', owner: 'terminal', shape: 'block' },
  'terminal-tab': { label: 'Terminal', owner: 'terminal', shape: 'block' },
  'screen-sidebar': { label: 'Screens', owner: 'screen', shape: 'block' },
  'screen-group-action': { label: '+', owner: 'screen', shape: 'inline' },
  'chat-thread': { label: 'Conversation', owner: 'chat', shape: 'block' },
  'chat-thread-panel': {
    label: 'Child thread conversation',
    owner: 'chat',
    shape: 'block',
  },
};

const infoOf = (tag: string): ElementInfo =>
  elementInfo[tag] ?? { label: tag, owner: 'another', shape: 'block' };

const shapeStyle: Record<ElementInfo['shape'], CSSProperties> = {
  inline: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '22px',
    padding: '0 6px',
    border: '1px dashed var(--border)',
    borderRadius: '4px',
    fontSize: '11px',
    whiteSpace: 'nowrap',
    color: 'var(--muted-foreground)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    height: '28px',
    margin: '0 8px',
    paddingLeft: '1.5rem',
    border: '1px dashed var(--border)',
    borderRadius: '4px',
    fontSize: '12px',
    color: 'var(--muted-foreground)',
  },
  block: {
    display: 'flex',
    flex: '1 1 auto',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    minHeight: '96px',
    height: 'calc(100% - 16px)',
    margin: '8px',
    border: '1px dashed var(--border)',
    borderRadius: '8px',
    fontSize: '12px',
    textAlign: 'center',
    color: 'var(--muted-foreground)',
  },
};

const caption = (tag: string, info: ElementInfo): string =>
  `<${tag}> · ${info.owner} bundle`;

/** The DOM stand-in the fake `ui/v1` creates for `tag`. */
export const placeholderElement = (
  tag: string,
  props?: Readonly<Record<string, unknown>>,
  label?: string,
): HTMLElement => {
  const info = infoOf(tag);
  const element = document.createElement(
    info.shape === 'inline' ? 'span' : 'div',
  );
  element.dataset.storyPlaceholder = tag;
  Object.assign(element.style, shapeStyle[info.shape]);
  element.title = caption(tag, info);
  const text = label ?? info.label;
  if (info.shape === 'block') {
    const title = document.createElement('span');
    title.textContent = text;
    title.style.color = 'var(--foreground)';
    title.style.fontWeight = '500';
    const detail = document.createElement('span');
    const target = props?.path ?? props?.['thread-id'] ?? props?.threadId;
    detail.textContent =
      typeof target === 'string'
        ? `${caption(tag, info)} · ${target}`
        : caption(tag, info);
    element.append(title, detail);
  } else {
    element.textContent = text;
  }
  return element;
};

/** The React stand-in for a slot a story fills itself. */
export function Placeholder({
  tag,
  label,
}: {
  readonly tag: string;
  readonly label?: string;
}) {
  const info = infoOf(tag);
  if (info.shape !== 'block') {
    return (
      <span style={shapeStyle[info.shape]} title={caption(tag, info)}>
        {label ?? info.label}
      </span>
    );
  }
  return (
    <div style={shapeStyle.block} title={caption(tag, info)}>
      <span style={{ color: 'var(--foreground)', fontWeight: 500 }}>
        {label ?? info.label}
      </span>
      <span>{caption(tag, info)}</span>
    </div>
  );
}
