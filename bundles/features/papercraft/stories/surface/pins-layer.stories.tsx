import { type ComponentType, useState } from 'react';

import {
  type CommentPin,
  PinsLayer,
} from '../../src/client/surface/pins-layer.js';
import { ThreadPopover } from '../../src/client/surface/thread-popover.js';
import { IDENTITY, type Viewport } from '../../src/client/surface/viewport.js';
import { AREA, CanvasArea } from '../support/frame.js';
import { OPEN_THREAD, PINS, SOURCE } from '../support/preview.js';

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
        onSend: () => setValue(''),
        onBlurOutside: () => undefined,
      }}
    />
  );
}

export default {
  title: 'Papercraft/Surface/Pins layer',
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
          onSend={() => undefined}
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
