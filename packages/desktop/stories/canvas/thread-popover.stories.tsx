import {
  type CommentPin,
  gridBackground,
  IDENTITY,
  PinsLayer,
  type ThreadMessage,
  ThreadPopover,
  type ThreadState,
} from 'desktop/ui/canvas';
import {
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  useState,
} from 'react';

/** The size of the bare canvas area the overlay stories draw on. */
const AREA = { width: 720, height: 480 } as const;

/** A bare canvas: the frame's dot grid, the room the overlays position in. */
function CanvasArea({
  children,
  height = AREA.height,
}: {
  readonly children?: ReactNode;
  readonly height?: number;
}) {
  const style: CSSProperties = {
    width: AREA.width,
    height,
    ...gridBackground(IDENTITY),
  };

  return (
    <div
      className="papercraft-container relative overflow-hidden rounded-lg border border-border bg-card"
      style={style}
    >
      {children}
    </div>
  );
}

const SOURCE = 'src/components/Checkout.tsx';

/** An ISO time `minutes` before now, so the relative times read naturally. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** The messages of the open thread on the pay button. */
const OPEN_THREAD: readonly ThreadMessage[] = [
  {
    id: 'comment-pay-label',
    text: 'The pay button should say the total, not just "Pay now".',
    createdAt: minutesAgo(32),
    draft: false,
  },
  {
    id: 'comment-pay-label-reply',
    text: 'Agreed, and keep it on one line at 360px.',
    createdAt: minutesAgo(30),
    draft: false,
  },
];

/** The thread on the seats row, where the agent spoke last. */
const AWAITING_THREAD: readonly ThreadMessage[] = [
  {
    id: 'comment-seats',
    text: 'Should extra seats be monthly here, or annual like the plan?',
    createdAt: minutesAgo(25),
    draft: false,
  },
  {
    id: 'comment-seats-agent',
    author: 'agent',
    text: 'They bill with the plan, so annual. Do you want the per-month price shown next to it?',
    createdAt: minutesAgo(22),
    draft: false,
  },
];

/** A resolved thread. */
const RESOLVED_THREAD: readonly ThreadMessage[] = [
  {
    id: 'comment-heading',
    text: 'Heading is too loud next to the lead text.',
    createdAt: minutesAgo(50),
    draft: false,
  },
  {
    id: 'comment-heading-agent',
    author: 'agent',
    text: 'Dropped the heading to 18px semibold and tightened the gap.',
    createdAt: minutesAgo(44),
    draft: false,
  },
];

/** A thread whose root is still a draft in the stack. */
const DRAFT_THREAD: readonly ThreadMessage[] = [
  {
    id: 'draft-total',
    text: 'Bold the total amount, not the label.',
    draft: true,
  },
];

const POINT = { x: 180, y: 96 };

/**
 * One thread open beside its pin, with the reply (or the edit) the reader is
 * writing, as the canvas keeps it: confirming a reply adds it to the
 * messages as a draft of the stack, and removing a draft drops it.
 */
function Thread({
  pin = 1,
  title = 'Checkout:21',
  line = 21,
  label = 'button#pay',
  messages: initial,
  state,
  canResolve = true,
  initialValue = '',
  point = POINT,
}: {
  readonly pin?: number;
  readonly title?: string;
  readonly line?: number;
  readonly label?: string;
  readonly messages: readonly ThreadMessage[];
  readonly state?: ThreadState;
  readonly canResolve?: boolean;
  readonly initialValue?: string;
  readonly point?: { readonly x: number; readonly y: number };
}) {
  const [messages, setMessages] = useState(initial);
  const [current, setCurrent] = useState(state);
  const [value, setValue] = useState(initialValue);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [showResolved, setShowResolved] = useState(true);
  const [open, setOpen] = useState(true);

  const draft = messages[0]?.draft === true;
  const balloon: CommentPin = {
    key: messages[0]?.id ?? 'pin',
    pin,
    point,
    state: draft ? 'draft' : (current ?? 'open'),
    replies: messages.length - 1,
    note: messages[0]?.text ?? '',
  };

  const confirm = () => {
    const note = value.trim();

    if (editing !== undefined) {
      setMessages((list) =>
        note === ''
          ? list.filter((message) => message.id !== editing)
          : list.map((message) =>
              message.id === editing ? { ...message, text: note } : message,
            ),
      );
    } else if (note !== '') {
      setMessages((list) => [
        ...list,
        { id: `draft-${String(list.length)}`, text: note, draft: true },
      ]);
    }

    setValue('');
    setEditing(undefined);
  };

  return (
    <PinsLayer
      pins={[balloon]}
      viewport={IDENTITY}
      area={AREA}
      activeKey={open ? balloon.key : undefined}
      onOpenPin={() => setOpen(true)}
    >
      {open ? (
        <ThreadPopover
          point={point}
          viewport={IDENTITY}
          area={AREA}
          pin={pin}
          title={title}
          anchor={`${SOURCE}:${String(line)} · ${label} · rev 1`}
          messages={messages}
          {...(current === undefined || draft
            ? {}
            : {
                state: current,
                onResolve: () =>
                  setCurrent((was) => (was === 'done' ? 'open' : 'done')),
              })}
          canResolve={canResolve}
          showResolved={showResolved}
          onToggleShowResolved={() => setShowResolved((shown) => !shown)}
          value={value}
          editing={editing !== undefined}
          onChange={setValue}
          onConfirm={confirm}
          onCancel={() => {
            setValue('');
            setEditing(undefined);
          }}
          onClose={() => setOpen(false)}
          onEdit={(id) => {
            setEditing(id);
            setValue(messages.find((message) => message.id === id)?.text ?? '');
          }}
          onRemove={(id) =>
            setMessages((list) => list.filter((message) => message.id !== id))
          }
          onCopy={() => undefined}
        />
      ) : null}
    </PinsLayer>
  );
}

export default {
  title: 'desktop/ui/Canvas/Thread popover',
  component: ThreadPopover,
  decorators: [
    (Story: ComponentType) => (
      <CanvasArea>
        <Story />
      </CanvasArea>
    ),
  ],
};

/** An open thread: the reader's root and a reply, and the reply row. */
export const Open = {
  render: () => <Thread messages={OPEN_THREAD} state="open" />,
};

/** The agent spoke last: the thread awaits the reader. */
export const AwaitingReply = {
  render: () => (
    <Thread
      pin={2}
      title="Checkout:17"
      line={17}
      label="li"
      messages={AWAITING_THREAD}
      state="await"
    />
  ),
};

export const Resolved = {
  render: () => (
    <Thread
      pin={3}
      title="Checkout:12"
      line={12}
      label="h1"
      messages={RESOLVED_THREAD}
      state="done"
    />
  ),
};

/** The root is still a draft in the composer stack: "na pilha", no resolve. */
export const DraftRoot = {
  render: () => (
    <Thread
      pin={4}
      title="Checkout:18"
      line={18}
      label="li.total"
      messages={DRAFT_THREAD}
    />
  ),
};

/** A sent thread with a draft reply waiting for the next prompt. */
export const DraftReply = {
  render: () => (
    <Thread
      messages={[
        ...OPEN_THREAD,
        {
          id: 'draft-pay-reply',
          text: 'Use the currency format of the locale too.',
          draft: true,
        },
      ]}
      state="open"
    />
  ),
};

/** The reader is writing a reply. */
export const Replying = {
  render: () => (
    <Thread
      messages={AWAITING_THREAD}
      state="await"
      initialValue="Yes, show $8/month next to the annual price."
    />
  ),
};

/** The root has no prompt to write the resolve under yet. */
export const CannotResolve = {
  render: () => (
    <Thread messages={OPEN_THREAD} state="open" canResolve={false} />
  ),
};

/** A long conversation: the messages scroll inside the popover. */
export const LongThread = {
  render: () => (
    <Thread
      messages={[
        ...AWAITING_THREAD,
        {
          id: 'comment-seats-2',
          text: 'Show it, but smaller and muted, under the annual price.',
          createdAt: minutesAgo(20),
          draft: false,
        },
        {
          id: 'comment-seats-agent-2',
          author: 'agent',
          text: 'Done in rev 2: "$8/mo billed annually" in the muted foreground at 12px, aligned to the right edge of the price column. I also wrapped the seat label so it never pushes the price onto a second line at the 360px card width.',
          createdAt: minutesAgo(15),
          draft: false,
        },
        {
          id: 'comment-seats-3',
          text: 'Looks right. Can the seat count be editable inline?',
          createdAt: minutesAgo(6),
          draft: false,
        },
        {
          id: 'comment-seats-agent-3',
          author: 'agent',
          text: 'It can: a small stepper replaces "× 2". Should it update the total live?',
          createdAt: minutesAgo(2),
          draft: false,
        },
      ]}
      state="await"
    />
  ),
};

/** A pin near the bottom edge: the popover opens above it. */
export const NearBottomEdge = {
  render: () => (
    <Thread messages={OPEN_THREAD} state="open" point={{ x: 420, y: 430 }} />
  ),
};
