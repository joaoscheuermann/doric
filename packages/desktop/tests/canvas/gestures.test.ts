// The canvas's gestures (`desktop/ui/canvas`): what a click, a move, a press,
// the wheel and the keys do, whether the pointer comes as native events on
// the canvas or as the reports of a sandboxed frame. What lies under the
// pointer is the owner's answer (`CanvasHitTester`), so the hook is tested
// with a stand-in tester that names each target after the content point and
// the mode it was asked in.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  type CanvasHitTester,
  type CanvasKey,
  type CanvasPointerAt,
  type ContentPoint,
  canvasKeys,
  type GestureInput,
  IDENTITY,
  type KeyInput,
  OVERLAY_ATTRIBUTE,
  type ReportedPointer,
  type ReportedWheel,
  useCanvasGestures,
  type Viewport,
} from 'desktop/ui/canvas';

import { closeDom, renderHook } from './support/dom.js';

after(closeDom);

interface Anchor {
  readonly target: string | undefined;
  readonly at: ContentPoint;
}

/** Names the target under the pointer `<mode>@<x>,<y>`, and records what it was asked. */
const stubHits = () => {
  const asked: CanvasPointerAt[] = [];
  const hits: CanvasHitTester<Anchor> = {
    targetAt: (pointer, mode) => {
      asked.push(pointer);
      return `${mode}@${pointer.content.x},${pointer.content.y}`;
    },
    anchorAt: (pointer, targetId) => ({
      target: targetId,
      at: pointer.content,
    }),
  };
  return { hits, asked };
};

const useGestures = (input: GestureInput<Anchor>) => useCanvasGestures(input);

const setup = async (overrides: Partial<GestureInput<Anchor>> = {}) => {
  const wrapper = document.createElement('div');
  const overlay = document.createElement('div');
  const inOverlay = document.createElement('button');
  overlay.setAttribute(OVERLAY_ATTRIBUTE, '');
  overlay.append(inOverlay);
  wrapper.append(overlay);
  document.body.append(wrapper);

  let viewport: Viewport = overrides.viewport ?? IDENTITY;
  const { hits, asked } = stubHits();
  const log = {
    selected: [] as (string | undefined)[],
    hovered: [] as (string | undefined)[],
    commented: [] as { anchor: Anchor; point: ContentPoint }[],
    resolved: 0,
  };
  const input: GestureInput<Anchor> = {
    wrapper: { current: wrapper },
    chrome: 'canvas',
    focusedRef: { current: false },
    hits,
    viewport,
    tool: 'select',
    active: true,
    spaceHeld: false,
    hoverId: undefined,
    inputOpen: false,
    canComment: true,
    setViewport: (action) => {
      viewport = typeof action === 'function' ? action(viewport) : action;
    },
    setSpaceHeld: () => undefined,
    onHover: (id) => log.hovered.push(id),
    onSelect: (id) => log.selected.push(id),
    focusCanvas: () => undefined,
    resolveInput: () => {
      log.resolved += 1;
    },
    onComment: (anchor, point) => log.commented.push({ anchor, point }),
    ...overrides,
  };
  const hook = await renderHook(useGestures, input);

  return {
    wrapper,
    inOverlay,
    asked,
    log,
    viewport: () => viewport,
    gestures: () => hook.result(),
    cleanup: async () => {
      await hook.unmount();
      wrapper.remove();
    },
  };
};

const at = (x: number, y: number, more: Record<string, unknown> = {}) => ({
  bubbles: true,
  cancelable: true,
  composed: true,
  clientX: x,
  clientY: y,
  ...more,
});

const click = (target: EventTarget, x: number, y: number, more = {}) =>
  target.dispatchEvent(new MouseEvent('click', at(x, y, more)));

const pointer = (
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  more = {},
) =>
  target.dispatchEvent(
    new PointerEvent(type, at(x, y, { pointerId: 1, ...more })),
  );

// happy-dom's WheelEvent extends UIEvent, not MouseEvent, so it drops the
// pointer position and the modifier keys a browser's wheel event carries;
// they are defined on the event as a browser would report them.
const wheel = (target: EventTarget, init: Record<string, unknown>) => {
  const full: Record<string, unknown> = at(100, 50, init);
  const event = new WheelEvent('wheel', full);
  for (const key of [
    'clientX',
    'clientY',
    'ctrlKey',
    'metaKey',
    'shiftKey',
    'altKey',
  ] as const) {
    const value = full[key] ?? (key.endsWith('Key') ? false : 0);
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return target.dispatchEvent(event);
};

const report = (
  type: ReportedPointer['type'],
  point: ContentPoint,
  more: Partial<ReportedPointer> = {},
): ReportedPointer => ({
  type,
  point,
  button: 0,
  buttons: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...more,
});

const reportWheel = (more: Partial<ReportedWheel>): ReportedWheel => ({
  point: { x: 100, y: 50 },
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...more,
});

describe('a click', () => {
  test('in select mode selects the select target under the pointer', async () => {
    const canvas = await setup();
    click(canvas.wrapper, 30, 40);
    assert.deepEqual(canvas.log.selected, ['select@30,40']);
    await canvas.cleanup();
  });

  test('reads the content point under any pan and zoom', async () => {
    const canvas = await setup({ viewport: { scale: 2, tx: 10, ty: 20 } });
    click(canvas.wrapper, 50, 60);
    assert.deepEqual(canvas.log.selected, ['select@20,20']);
    await canvas.cleanup();
  });

  test('in comment mode comments at the point target’s anchor', async () => {
    const canvas = await setup({ tool: 'comment' });
    click(canvas.wrapper, 30, 40);
    assert.deepEqual(canvas.log.commented, [
      {
        anchor: { target: 'point@30,40', at: { x: 30, y: 40 } },
        point: { x: 30, y: 40 },
      },
    ]);
    assert.deepEqual(canvas.log.selected, []);
    await canvas.cleanup();
  });

  test('with Alt in comment mode comments at a free point', async () => {
    const canvas = await setup({ tool: 'comment' });
    click(canvas.wrapper, 30, 40, { altKey: true });
    assert.deepEqual(canvas.log.commented, [
      {
        anchor: { target: undefined, at: { x: 30, y: 40 } },
        point: { x: 30, y: 40 },
      },
    ]);
    await canvas.cleanup();
  });

  test('in comment mode does nothing while commenting is not possible', async () => {
    const canvas = await setup({ tool: 'comment', canComment: false });
    click(canvas.wrapper, 30, 40);
    assert.deepEqual(canvas.log.commented, []);
    await canvas.cleanup();
  });

  test('without a hit-test selects nothing and comments nothing', async () => {
    const select = await setup({ hits: undefined });
    click(select.wrapper, 30, 40);
    assert.deepEqual(select.log.selected, [undefined]);
    await select.cleanup();

    const comment = await setup({ hits: undefined, tool: 'comment' });
    click(comment.wrapper, 30, 40);
    assert.deepEqual(comment.log.commented, []);
    await comment.cleanup();
  });
});

describe('hover', () => {
  test('outlines the point target under the pointer', async () => {
    const canvas = await setup();
    pointer(canvas.wrapper, 'pointermove', 30, 40);
    assert.deepEqual(canvas.log.hovered, ['point@30,40']);
    await canvas.cleanup();
  });

  test('with Alt in comment mode outlines nothing', async () => {
    const canvas = await setup({ tool: 'comment', hoverId: 'point@1,1' });
    pointer(canvas.wrapper, 'pointermove', 30, 40, { altKey: true });
    assert.deepEqual(canvas.log.hovered, [undefined]);
    await canvas.cleanup();
  });

  test('while panning outlines nothing', async () => {
    for (const panning of [{ tool: 'pan' as const }, { spaceHeld: true }]) {
      const canvas = await setup(panning);
      pointer(canvas.wrapper, 'pointermove', 30, 40);
      assert.ok(
        canvas.log.hovered.every((id) => id === undefined),
        JSON.stringify(canvas.log.hovered),
      );
      await canvas.cleanup();
    }
  });

  test('leaving the canvas clears the outline', async () => {
    const canvas = await setup({ hoverId: 'point@30,40' });
    pointer(canvas.wrapper, 'pointerleave', 30, 40, { bubbles: false });
    assert.deepEqual(canvas.log.hovered, [undefined]);
    await canvas.cleanup();
  });
});

describe('pan', () => {
  test('a drag with the pan tool, or with space held, moves the view by the pointer', async () => {
    for (const panning of [{ tool: 'pan' as const }, { spaceHeld: true }]) {
      const canvas = await setup(panning);
      pointer(canvas.wrapper, 'pointerdown', 10, 10);
      assert.equal(canvas.gestures().panning(), true);
      pointer(canvas.wrapper, 'pointermove', 25, 40);
      assert.deepEqual(canvas.viewport(), { scale: 1, tx: 15, ty: 30 });
      pointer(canvas.wrapper, 'pointerup', 25, 40);
      assert.equal(canvas.gestures().panning(), false);
      await canvas.cleanup();
    }
  });
});

describe('the overlay and the open input', () => {
  test('events from the overlay are not the canvas’s', async () => {
    const canvas = await setup();
    click(canvas.inOverlay, 30, 40);
    pointer(canvas.inOverlay, 'pointermove', 30, 40);
    assert.deepEqual(canvas.log.selected, []);
    assert.deepEqual(canvas.log.hovered, []);
    await canvas.cleanup();
  });

  test('a press with an input open resolves it, and its click is consumed', async () => {
    const canvas = await setup({ inputOpen: true });
    pointer(canvas.wrapper, 'pointerdown', 30, 40);
    assert.equal(canvas.log.resolved, 1);
    click(canvas.wrapper, 30, 40);
    assert.deepEqual(canvas.log.selected, []);
    // Only that click: the next one acts again.
    click(canvas.wrapper, 30, 40);
    assert.deepEqual(canvas.log.selected, ['select@30,40']);
    await canvas.cleanup();
  });
});

describe('the wheel', () => {
  test('over an unfocused node, without a modifier, leaves the view alone', async () => {
    const canvas = await setup({ chrome: 'node' });
    wheel(canvas.wrapper, { deltaX: 5, deltaY: 7 });
    assert.deepEqual(canvas.viewport(), IDENTITY);
    await canvas.cleanup();
  });

  test('with ctrl or meta zooms around the pointer', async () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const canvas = await setup({ chrome: 'node' });
      wheel(canvas.wrapper, { deltaY: -10, ...modifier });
      const zoomed = canvas.viewport();
      assert.ok(zoomed.scale > 1, `scale ${zoomed.scale}`);
      // What was under the pointer (100, 50) stays under it.
      assert.ok(Math.abs(zoomed.tx + 100 * zoomed.scale - 100) < 1e-9);
      assert.ok(Math.abs(zoomed.ty + 50 * zoomed.scale - 50) < 1e-9);
      await canvas.cleanup();
    }
  });

  test('over the canvas chrome pans, a line counting 16 pixels', async () => {
    const pixels = await setup();
    wheel(pixels.wrapper, { deltaX: 2, deltaY: 3 });
    assert.deepEqual(pixels.viewport(), { scale: 1, tx: -2, ty: -3 });
    await pixels.cleanup();

    const lines = await setup();
    wheel(lines.wrapper, { deltaX: 2, deltaY: 3, deltaMode: 1 });
    assert.deepEqual(lines.viewport(), { scale: 1, tx: -32, ty: -48 });
    await lines.cleanup();
  });
});

describe('the frame’s reports', () => {
  test('the tester hears the reported point, node and pseudo-element', async () => {
    const canvas = await setup();
    canvas
      .gestures()
      .framePointer(
        report('click', { x: 7, y: 8 }, { nodeId: 'n4', pseudo: '::before' }),
      );
    assert.deepEqual(canvas.log.selected, ['select@7,8']);
    const asked = canvas.asked.at(-1);
    assert.deepEqual(asked?.content, { x: 7, y: 8 });
    assert.equal(asked?.nodeId, 'n4');
    assert.equal(asked?.pseudo, '::before');
    await canvas.cleanup();
  });

  test('a reported comment click, hover and pan answer as native ones do', async () => {
    const comment = await setup({ tool: 'comment' });
    comment
      .gestures()
      .framePointer(report('click', { x: 7, y: 8 }, { altKey: true }));
    assert.deepEqual(comment.log.commented, [
      {
        anchor: { target: undefined, at: { x: 7, y: 8 } },
        point: { x: 7, y: 8 },
      },
    ]);
    await comment.cleanup();

    const hover = await setup({ hoverId: 'point@1,1' });
    hover.gestures().framePointer(report('move', { x: 7, y: 8 }));
    hover.gestures().framePointer(report('leave', { x: 7, y: 8 }));
    assert.deepEqual(hover.log.hovered, ['point@7,8', undefined]);
    await hover.cleanup();

    const pan = await setup({ tool: 'pan' });
    pan.gestures().framePointer(report('down', { x: 10, y: 10 }));
    pan.gestures().framePointer(report('move', { x: 25, y: 40 }));
    assert.deepEqual(pan.viewport(), { scale: 1, tx: 15, ty: 30 });
    pan.gestures().framePointer(report('up', { x: 25, y: 40 }));
    assert.equal(pan.gestures().panning(), false);
    await pan.cleanup();
  });

  test('a reported wheel zooms and pans as a native one does', async () => {
    const zoom = await setup();
    zoom.gestures().frameWheel(reportWheel({ deltaY: -10, ctrlKey: true }));
    const zoomed = zoom.viewport();
    assert.ok(zoomed.scale > 1);
    assert.ok(Math.abs(zoomed.tx + 100 * zoomed.scale - 100) < 1e-9);
    await zoom.cleanup();

    const pan = await setup();
    pan
      .gestures()
      .frameWheel(reportWheel({ deltaX: 2, deltaY: 3, deltaMode: 1 }));
    assert.deepEqual(pan.viewport(), { scale: 1, tx: -32, ty: -48 });
    await pan.cleanup();

    const node = await setup({ chrome: 'node' });
    node.gestures().frameWheel(reportWheel({ deltaX: 2, deltaY: 3 }));
    assert.deepEqual(node.viewport(), IDENTITY);
    await node.cleanup();
  });
});

describe('canvasKeys', () => {
  const keys = (overrides: Partial<KeyInput> = {}) => {
    const log: string[] = [];
    const input: KeyInput = {
      chrome: 'canvas',
      tool: 'select',
      inputOpen: false,
      canComment: true,
      release: () => log.push('release'),
      setSpaceHeld: (held) => log.push(`space:${held}`),
      setCommentMode: (on) => log.push(`comment:${on}`),
      closeInput: () => log.push('close'),
      ...overrides,
    };
    return { log, ...canvasKeys(input) };
  };

  const key = (name: string, more: Partial<CanvasKey> = {}): CanvasKey => ({
    key: name,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault: () => undefined,
    ...more,
  });

  test('space holds the pan while it is down', () => {
    const canvas = keys();
    canvas.onKeyDown(key(' '));
    canvas.onKeyUp(key(' '));
    assert.deepEqual(canvas.log, ['space:true', 'space:false']);
  });

  test('Esc closes the open input first', () => {
    const canvas = keys({ inputOpen: true, tool: 'comment', chrome: 'node' });
    canvas.onKeyDown(key('Escape'));
    assert.deepEqual(canvas.log, ['close']);
  });

  test('Esc with nothing open disarms the comment tool', () => {
    const canvas = keys({ tool: 'comment', chrome: 'node' });
    canvas.onKeyDown(key('Escape'));
    assert.deepEqual(canvas.log, ['comment:false']);
  });

  test('Esc with nothing left lets the node give the focus back', () => {
    const node = keys({ chrome: 'node' });
    node.onKeyDown(key('Escape'));
    assert.deepEqual(node.log, ['release']);

    const canvas = keys({ chrome: 'canvas' });
    canvas.onKeyDown(key('Escape'));
    assert.deepEqual(canvas.log, []);
  });

  test('Esc that cancels something is taken, so the modal does not close on it', () => {
    const prevents = (overrides: Partial<KeyInput>): boolean => {
      let prevented = false;
      keys(overrides).onKeyDown(
        key('Escape', {
          preventDefault: () => {
            prevented = true;
          },
        }),
      );
      return prevented;
    };

    assert.equal(prevents({ inputOpen: true }), true, 'closing the input');
    assert.equal(prevents({ tool: 'comment' }), true, 'disarming the tool');
    assert.equal(prevents({ chrome: 'node' }), true, 'releasing the node');
    assert.equal(
      prevents({ chrome: 'canvas' }),
      false,
      'nothing to cancel on the canvas',
    );
  });

  test('C toggles comment mode only while commenting is possible', () => {
    const arm = keys();
    arm.onKeyDown(key('c'));
    assert.deepEqual(arm.log, ['comment:true']);

    const disarm = keys({ tool: 'comment' });
    disarm.onKeyDown(key('C'));
    assert.deepEqual(disarm.log, ['comment:false']);

    const cannot = keys({ canComment: false });
    cannot.onKeyDown(key('c'));
    assert.deepEqual(cannot.log, []);

    const chord = keys();
    chord.onKeyDown(key('c', { metaKey: true }));
    assert.deepEqual(chord.log, []);
  });

  test('Cmd/Ctrl+Enter is not the canvas’s', () => {
    let prevented = 0;
    const canvas = keys();
    for (const chord of [{ metaKey: true }, { ctrlKey: true }])
      canvas.onKeyDown(
        key('Enter', {
          ...chord,
          preventDefault: () => {
            prevented += 1;
          },
        }),
      );
    assert.deepEqual(canvas.log, []);
    assert.equal(prevented, 0);
  });
});
