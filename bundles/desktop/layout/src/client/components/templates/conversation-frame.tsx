import type { CSSProperties, ReactNode } from 'react';

/**
 * The band's geometry (conversation-footer spec, D2 and D13): 44 px, `py-2`
 * over and under the 28 px row. Its height, fill and blur are this bundle's
 * sheet rule; the height reads `--shell-conversation-footer-height`.
 */
const CONVERSATION_FOOTER =
  'absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 py-2 pl-2 text-[11px] font-normal';

/**
 * The band's height for `<chat-view>` (`--shell-conversation-footer-height`, chat's
 * README): its bar ends and its scroll padding stops where the band begins.
 * The band's 44 px, which the sheet rule reads as its height.
 */
const FOOTER_HEIGHT = {
  '--shell-conversation-footer-height': '2.75rem',
} as CSSProperties;

/**
 * The conversation, and over its bottom 44 px the floating conversation
 * footer, which draws `footer` (the `shell.conversation.footer` region). The conversation
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
