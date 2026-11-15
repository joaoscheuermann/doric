import type { CSSProperties, ReactNode } from 'react';

/**
 * The band's geometry (conversation-footer spec, D2): 36 px, `pt-2` over the
 * 28 px row. Its fill and blur are this bundle's sheet rules.
 */
const CONVERSATION_FOOTER =
  'absolute inset-x-0 bottom-0 flex h-9 items-center justify-end gap-1 pt-2 pl-2 text-[11px] font-normal';

/**
 * The band's height for `<chat-view>` (`--chat-footer-height`, chat's
 * README): its bar ends and its scroll padding stops where the band begins.
 * Equal to the band's `h-9`.
 */
const FOOTER_HEIGHT = { '--chat-footer-height': '2.25rem' } as CSSProperties;

/**
 * The conversation, and over its bottom 36 px the floating conversation
 * footer, which draws `footer` (the `layout.footer` region). The conversation
 * runs on under the footer.
 */
export function ConversationFrame({
  children,
  footer,
}: {
  readonly children: ReactNode;
  readonly footer: ReactNode;
}) {
  return (
    <div
      data-slot="conversation-frame"
      className="relative flex min-h-0 flex-1 flex-col"
      style={FOOTER_HEIGHT}
    >
      {children}
      <footer data-slot="workspace-footer" className={CONVERSATION_FOOTER}>
        {footer}
      </footer>
    </div>
  );
}
