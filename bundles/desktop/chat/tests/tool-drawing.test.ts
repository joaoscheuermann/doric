// Which drawing a tool call gets (bundle isolation 5(a), `chat.views/v1`
// 1.2.0): a registration answers its own three facts, whole (O4); an
// unregistered tool gets the chat's built-in answer, which keeps today's
// standalone and open-by-default names until 5(b) moves them. And the key an
// input renderer is registered under.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  builtInDrawing,
  inputSourceKey,
  type ToolDrawing,
  toolDrawing,
} from '../src/client/domain/tool-drawing.js';
import type { ToolRendererSpec } from '../src/contracts/index.js';

const none: ReadonlyMap<string, ToolRendererSpec> = new Map();

/** The three facts of a drawing, with an absent element as `undefined`. */
const facts = (drawing: ToolDrawing) => ({
  elementTag: drawing.elementTag,
  standalone: drawing.standalone,
  openByDefault: drawing.openByDefault,
});

const registered = (
  ...specs: readonly ToolRendererSpec[]
): ReadonlyMap<string, ToolRendererSpec> =>
  new Map(specs.map((spec) => [spec.toolName, spec]));

describe('the drawing of an unregistered tool', () => {
  test('edit and write are standalone and open by default', () => {
    for (const name of ['edit', 'write']) {
      assert.deepEqual(
        facts(toolDrawing(name, none)),
        { elementTag: undefined, standalone: true, openByDefault: true },
        name,
      );
      assert.deepEqual(
        facts(builtInDrawing(name)),
        facts(toolDrawing(name, none)),
      );
    }
  });

  test('view-image is open by default and grouped', () => {
    assert.deepEqual(facts(toolDrawing('view-image', none)), {
      elementTag: undefined,
      standalone: false,
      openByDefault: true,
    });
  });

  test('thread-spawn and load_skill are standalone and closed', () => {
    for (const name of ['thread-spawn', 'load_skill']) {
      assert.deepEqual(
        facts(toolDrawing(name, none)),
        { elementTag: undefined, standalone: true, openByDefault: false },
        name,
      );
    }
  });

  test('any other name is grouped, closed and has no element', () => {
    for (const name of ['terminal', 'probe_tool', 'Edit', 'edit ']) {
      const drawing = toolDrawing(name, none);
      assert.equal(drawing.standalone, false, name);
      assert.equal(drawing.openByDefault, false, name);
      assert.equal(drawing.elementTag, undefined, name);
    }
  });
});

describe('the drawing of a registered tool', () => {
  test('answers the registration’s own three facts', () => {
    const drawing = toolDrawing(
      'probe_tool',
      registered({
        toolName: 'probe_tool',
        elementTag: 'probe-tool-call',
        standalone: true,
        openByDefault: true,
      }),
    );
    assert.equal(drawing.elementTag, 'probe-tool-call');
    assert.equal(drawing.standalone, true);
    assert.equal(drawing.openByDefault, true);
  });

  test('takes an absent flag as false', () => {
    const drawing = toolDrawing(
      'probe_tool',
      registered({ toolName: 'probe_tool', elementTag: 'probe-tool-call' }),
    );
    assert.equal(drawing.elementTag, 'probe-tool-call');
    assert.equal(drawing.standalone, false);
    assert.equal(drawing.openByDefault, false);
  });

  test('a registration of a built-in name replaces the built-in answer whole (O4)', () => {
    const drawing = toolDrawing('edit', registered({ toolName: 'edit' }));
    assert.equal(drawing.standalone, false);
    assert.equal(drawing.openByDefault, false);
    assert.equal(drawing.elementTag, undefined);
  });

  test('a registration answers for its own name only', () => {
    const map = registered({ toolName: 'probe_tool', standalone: true });
    assert.equal(toolDrawing('other_tool', map).standalone, false);
    assert.equal(toolDrawing('edit', map).standalone, true);
  });
});

describe('the key of an input source', () => {
  test('terminal, parent and result are their kind', () => {
    assert.equal(
      inputSourceKey({ kind: 'terminal', terminalId: 't1' }),
      'terminal',
    );
    assert.equal(inputSourceKey({ kind: 'parent', threadId: 'th1' }), 'parent');
    assert.equal(inputSourceKey({ kind: 'result', threadId: 'th1' }), 'result');
  });

  test('a bundle with id x is bundle:x', () => {
    assert.equal(
      inputSourceKey({ kind: 'bundle', bundleId: 'x', reason: 'why' }),
      'bundle:x',
    );
  });

  test('user and a bundle with no id have no key', () => {
    assert.equal(inputSourceKey({ kind: 'user' }), undefined);
    assert.equal(inputSourceKey({ kind: 'bundle' }), undefined);
  });
});
