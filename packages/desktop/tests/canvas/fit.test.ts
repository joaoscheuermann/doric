// Centring what a canvas shows (`desktop/ui/canvas`): each `contentKey` is
// fitted once, the first time its content fits (margin 48); a view the reader
// moved is the reader's; a resize asks the owner for a fresh measurement and
// keeps a view nobody moved fitted. The canvas's size is the element's client
// size, and its resizes are a fake `ResizeObserver` the test drives.

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';

import {
  type ContentBounds,
  fitViewport,
  IDENTITY,
  useFit,
  type Viewport,
} from 'desktop/ui/canvas';
import { useState } from 'react';

import { act, closeDom, renderHook } from './support/dom.js';

after(closeDom);

/** Every observer the hook made; `resize()` tells each its element changed. */
const observers: { callback: () => void; disconnected: boolean }[] = [];
class FakeResizeObserver {
  private readonly entry: { callback: () => void; disconnected: boolean };
  constructor(callback: () => void) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.entry.disconnected = true;
  }
}
const resize = () =>
  act(() => {
    for (const each of observers) if (!each.disconnected) each.callback();
  });

beforeEach(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  });
});
afterEach(() => {
  observers.length = 0;
});

/** A canvas element of the given client size. */
const areaOf = (width: number, height: number) => {
  const element = document.createElement('div');
  const size = { width, height };
  Object.defineProperty(element, 'clientWidth', { get: () => size.width });
  Object.defineProperty(element, 'clientHeight', { get: () => size.height });
  document.body.append(element);
  return { element, size };
};

interface Props {
  readonly wrapper: { current: HTMLDivElement | null };
  readonly content: ContentBounds | undefined;
  readonly contentKey: string;
  readonly requestMeasure: () => void;
}

/** The owner: it keeps the view, as a canvas does. */
const useOwner = (props: Props) => {
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const fit = useFit({ ...props, viewport, setViewport });
  return { fit, viewport, setViewport };
};

const first: ContentBounds = { x: 100, y: 50, width: 800, height: 600 };
const second: ContentBounds = { x: 0, y: 0, width: 1600, height: 400 };
const moved: Viewport = { scale: 1.5, tx: 12, ty: -7 };

describe('useFit', () => {
  test('fitContent centres the content with a 48 margin, and answers true', async () => {
    const { element } = areaOf(400, 300);
    const hook = await renderHook(useOwner, {
      wrapper: { current: element },
      content: first,
      contentKey: 'r1',
      requestMeasure: () => undefined,
    });
    await act(() => hook.result().setViewport(moved));

    let fitted: boolean | undefined;
    await act(() => {
      fitted = hook.result().fit.fitContent();
    });

    assert.equal(fitted, true);
    assert.deepEqual(
      hook.result().viewport,
      fitViewport(first, { width: 400, height: 300 }, 48),
    );
    await hook.unmount();
  });

  test('fitContent without content answers false and leaves the view', async () => {
    const { element } = areaOf(400, 300);
    const hook = await renderHook(useOwner, {
      wrapper: { current: element },
      content: undefined,
      contentKey: 'r1',
      requestMeasure: () => undefined,
    });

    let fitted: boolean | undefined;
    await act(() => {
      fitted = hook.result().fit.fitContent();
    });

    assert.equal(fitted, false);
    assert.deepEqual(hook.result().viewport, IDENTITY);
    await hook.unmount();
  });

  test('the first content of a key is fitted once; a moved view is the reader’s', async () => {
    const { element } = areaOf(400, 300);
    const props: Props = {
      wrapper: { current: element },
      content: first,
      contentKey: 'r1',
      requestMeasure: () => undefined,
    };
    const hook = await renderHook(useOwner, props);
    assert.deepEqual(
      hook.result().viewport,
      fitViewport(first, { width: 400, height: 300 }, 48),
    );

    await act(() => hook.result().setViewport(moved));
    await hook.rerender({ ...props, content: second });
    assert.deepEqual(hook.result().viewport, moved);

    // Another key is centred again.
    await hook.rerender({ ...props, content: second, contentKey: 'r2' });
    assert.deepEqual(
      hook.result().viewport,
      fitViewport(second, { width: 400, height: 300 }, 48),
    );
    await hook.unmount();
  });

  test('a resize under an untouched view asks for a measure and refits to it', async () => {
    const { element, size } = areaOf(400, 300);
    let measures = 0;
    const props: Props = {
      wrapper: { current: element },
      content: first,
      contentKey: 'r1',
      requestMeasure: () => {
        measures += 1;
      },
    };
    const hook = await renderHook(useOwner, props);

    size.width = 600;
    await resize();
    assert.ok(measures >= 1, 'the owner was asked for a fresh measurement');

    await hook.rerender({ ...props, content: second });
    assert.deepEqual(
      hook.result().viewport,
      fitViewport(second, { width: 600, height: 300 }, 48),
    );
    await hook.unmount();
  });
});
