import {
  type CommentPin,
  gridBackground,
  IDENTITY,
  PinsLayer,
  type ThreadMessage,
  ThreadPopover,
  type Viewport,
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

/** One pin per state, placed on a 720 × 480 canvas. */
const PINS: readonly CommentPin[] = [
  {
    key: 'comment-pay-label',
    pin: 1,
    point: { x: 420, y: 330 },
    state: 'open',
    replies: 1,
    note: 'The pay button should say the total, not just "Pay now".',
  },
  {
    key: 'comment-seats',
    pin: 2,
    point: { x: 360, y: 220 },
    state: 'await',
    replies: 1,
    note: 'Should extra seats be monthly here, or annual like the plan?',
  },
  {
    key: 'comment-heading',
    pin: 3,
    point: { x: 260, y: 120 },
    state: 'done',
    replies: 0,
    note: 'Heading is too loud next to the lead text.',
  },
  {
    key: 'draft-total',
    pin: 4,
    point: { x: 470, y: 270 },
    state: 'draft',
    replies: 0,
    note: 'Bold the total amount, not the label.',
  },
  {
    key: 'comment-coupon',
    pin: 5,
    point: { x: 0, y: 28 },
    state: 'open',
    replies: 0,
    note: 'Where did the coupon field go?',
    detached: true,
  },
];

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

/** The pins with the one whose thread is open, as the canvas tracks it. */
function Pins({
  pins = PINS,
  viewport = IDENTITY,
  active,
}: {
  readonly pins?: readonly CommentPin[];
  readonly viewport?: Viewport;
  readonly active?: string;
}) {
  const [activeKey, setActiveKey] = useState(active);

  return (
    <PinsLayer
      pins={pins}
      viewport={viewport}
      area={AREA}
      {...(activeKey === undefined ? {} : { activeKey })}
      onOpenPin={(pin) => setActiveKey(pin.key)}
    />
  );
}

/** The inline input of a new comment, open at its pending pin. */
function NewComment({
  point,
  initial = '',
}: {
  readonly point: { readonly x: number; readonly y: number };
  readonly initial?: string;
}) {
  const [value, setValue] = useState(initial);

  return (
    <PinsLayer
      pins={PINS.filter((pin) => !pin.detached)}
      viewport={IDENTITY}
      area={AREA}
      input={{
        point,
        value,
        onChange: setValue,
        onConfirm: () => setValue(''),
        onCancel: () => setValue(''),
        onBlurOutside: () => undefined,
      }}
    />
  );
}

export default {
  title: 'desktop/ui/Canvas/Pins layer',
  component: PinsLayer,
  decorators: [
    (Story: ComponentType) => (
      <CanvasArea>
        <Story />
      </CanvasArea>
    ),
  ],
};

/**
 * Every pin state side by side: open, awaiting the reader, resolved, a draft
 * (dashed) and a detached pin stacked by the content's edge.
 */
export const AllStates = {
  render: () => <Pins />,
};

/** The pin whose thread is open wears the active ring. */
export const ActivePin = {
  render: () => <Pins active="comment-seats" />,
};

/** The pins ride pan and zoom without scaling. */
export const Zoomed = {
  render: () => <Pins viewport={{ scale: 0.6, tx: 120, ty: 60 }} />,
};

/** The inline comment input, open beside its pending pin. */
export const CommentInput = {
  render: () => <NewComment point={{ x: 300, y: 180 }} />,
};

export const CommentInputWithNote = {
  render: () => (
    <NewComment
      point={{ x: 300, y: 180 }}
      initial="Add 8px between the list and the button."
    />
  ),
};

/** No room on the right: the input opens left of its pin. */
export const CommentInputAtRightEdge = {
  render: () => <NewComment point={{ x: 640, y: 260 }} />,
};

/** A pin's thread open over the layer, as its child. */
export const WithThread = {
  render: () => {
    const pin = PINS[0] as CommentPin;

    return (
      <PinsLayer
        pins={PINS}
        viewport={IDENTITY}
        area={AREA}
        activeKey={pin.key}
      >
        <ThreadPopover
          point={pin.point}
          viewport={IDENTITY}
          area={AREA}
          pin={pin.pin}
          title="Checkout:21"
          anchor={`${SOURCE}:21 · button#pay · rev 1`}
          messages={OPEN_THREAD}
          state="open"
          onResolve={() => undefined}
          canResolve
          showResolved
          onToggleShowResolved={() => undefined}
          value=""
          editing={false}
          onChange={() => undefined}
          onConfirm={() => undefined}
          onCancel={() => undefined}
          onClose={() => undefined}
          onEdit={() => undefined}
          onRemove={() => undefined}
          onCopy={() => undefined}
        />
      </PinsLayer>
    );
  },
};

export const NoPins = {
  render: () => <Pins pins={[]} />,
};
