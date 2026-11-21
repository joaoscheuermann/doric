// Labelled stand-ins for the elements other bundles put in the account's
// slots (`account.status` badges, the icon elements of `account.menu`
// entries). The account only hosts them, so a story or a test shows where
// each one lands and who draws it instead of mounting another bundle. The DOM
// version is what the fake `ui/v1` returns; the React version fills a slot a
// story passes as a prop. A copy of the layout's (spec section 9), with the
// entries for the tags the account's two slots hold.

import type { CSSProperties } from 'react';

/** What a stand-in says: what the element is and which bundle draws it. */
export interface ElementInfo {
  readonly label: string;
  readonly owner: string;
  /**
   * `inline` sits in a bar, `row` in the sidebar tree, `block` fills a slot,
   * `badge` is a 14×14 round mark with no text (its label is the `title`).
   */
  readonly shape: 'inline' | 'row' | 'block' | 'badge';
}

/** The elements the running app mounts in the account, by tag. */
export const elementInfo: Readonly<Record<string, ElementInfo>> = {
  'resources-monitor': {
    label: 'Connection and resources',
    owner: 'resources',
    shape: 'badge',
  },
  'settings-entry-icon': { label: '⚙', owner: 'settings', shape: 'inline' },
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
  badge: {
    display: 'block',
    width: '14px',
    height: '14px',
    borderRadius: '9999px',
    border: '1px dashed var(--border)',
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
    info.shape === 'inline' || info.shape === 'badge' ? 'span' : 'div',
  );
  element.dataset.storyPlaceholder = tag;
  Object.assign(element.style, shapeStyle[info.shape]);
  element.title = caption(tag, info);
  const text = label ?? info.label;
  if (info.shape === 'badge') {
    element.title = `${text} · ${caption(tag, info)}`;
  } else if (info.shape === 'block') {
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
  if (info.shape === 'badge') {
    return (
      <span
        style={shapeStyle.badge}
        title={`${label ?? info.label} · ${caption(tag, info)}`}
      />
    );
  }
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
