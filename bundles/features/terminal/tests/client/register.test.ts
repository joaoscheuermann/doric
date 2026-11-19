// The terminal client part registers its chat drawings with `chat.views/v1`
// 1.2.0 (bundle isolation 5(b), change 4, `:1033`, `:1046`): it defines
// `terminal-tool-call` and `terminal-result` through `ui/v1` beside its other
// elements, and registers the `terminal` tool (grouped and folded by the
// chat's generic facts) and the input source `terminal`, each in a
// `whenAvailable` callback of its own, so a refused registration leaves the
// other. Its cleanup disposes both. Without `chat.views/v1` it still defines
// its elements and registers nothing.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  InputRendererSpec,
  ToolRendererSpec,
} from '../../src/client/peers.js';
import { installWindow } from './support/render.js';
import { fakeServices } from './support/services.js';
import { loadStylesheetsAsEmpty } from './support/stylesheets.js';

/** What the activation asked of `ui/v1` and `chat.views/v1`. */
interface Activation {
  readonly defined: readonly string[];
  readonly tools: readonly ToolRendererSpec[];
  readonly inputs: readonly InputRendererSpec[];
  /** What was disposed: tool names and `source:<source>`. */
  readonly disposed: readonly string[];
  /** What the `whenAvailable` callbacks threw, as the platform records it. */
  readonly failures: readonly unknown[];
  readonly cleanup: () => void;
}

/** Activates the terminal client part over fakes, `chat.views/v1` served or not. */
const activateWith = async (input: {
  readonly views: boolean;
  /** `registerToolRenderer` refuses, as for a name another bundle holds. */
  readonly refuseTool?: boolean;
  /** `registerInputRenderer` refuses, as for a source another bundle holds. */
  readonly refuseInput?: boolean;
}): Promise<Activation> => {
  installWindow();
  loadStylesheetsAsEmpty();
  const { activate } = await import('../../src/client/index.js');
  const defined: string[] = [];
  const tools: ToolRendererSpec[] = [];
  const inputs: InputRendererSpec[] = [];
  const disposed: string[] = [];
  const { services, failures } = fakeServices({
    'doric.connection/v1': {
      status: () => 'connected',
      subscribe: () => ({ dispose: () => undefined }),
    },
    'ui/v1': {
      define: (tag: string) => {
        defined.push(tag);
        return { dispose: () => undefined };
      },
    },
    ...(input.views
      ? {
          'chat.views/v1': {
            registerRenderer: () => ({ dispose: () => undefined }),
            registerProjector: () => ({ dispose: () => undefined }),
            registerToolRenderer: (spec: ToolRendererSpec) => {
              if (input.refuseTool === true)
                throw new Error(`${spec.toolName} is already registered.`);
              tools.push(spec);
              return { dispose: () => disposed.push(spec.toolName) };
            },
            registerInputRenderer: (spec: InputRendererSpec) => {
              if (input.refuseInput === true)
                throw new Error(`${spec.source} is already registered.`);
              inputs.push(spec);
              return { dispose: () => disposed.push(`source:${spec.source}`) };
            },
          },
        }
      : {}),
  });
  const cleanup = activate({ services } as unknown as Parameters<
    typeof activate
  >[0]);
  return {
    defined,
    tools,
    inputs,
    disposed,
    failures,
    cleanup: () => {
      if (typeof cleanup === 'function') void cleanup();
    },
  };
};

/** A spec's facts, an absent flag read as its default `false` (the contract's rule). */
const facts = (spec: ToolRendererSpec) => ({
  toolName: spec.toolName,
  elementTag: spec.elementTag,
  standalone: spec.standalone ?? false,
  openByDefault: spec.openByDefault ?? false,
});

describe('the terminal client part registers its chat drawings with chat.views/v1', () => {
  test('defines terminal-tool-call and terminal-result beside its other elements', async (t) => {
    const activation = await activateWith({ views: true });
    t.after(activation.cleanup);

    for (const tag of [
      'terminal-new-button',
      'terminal-rows',
      'terminal-tool-call',
      'terminal-result',
    ])
      assert.ok(
        activation.defined.includes(tag),
        `defined: ${activation.defined.join(', ')}`,
      );
  });

  test('registers the terminal tool, drawn by terminal-tool-call in the activity group, and the source terminal, drawn by terminal-result', async (t) => {
    const activation = await activateWith({ views: true });
    t.after(activation.cleanup);

    assert.deepEqual(activation.tools.map(facts), [
      {
        toolName: 'terminal',
        elementTag: 'terminal-tool-call',
        standalone: false,
        openByDefault: false,
      },
    ]);
    assert.deepEqual(
      activation.inputs.map(({ source, elementTag }) => ({
        source,
        elementTag,
      })),
      [{ source: 'terminal', elementTag: 'terminal-result' }],
    );
    assert.deepEqual(activation.failures, []);
  });

  test('the cleanup disposes both registrations', async () => {
    const activation = await activateWith({ views: true });
    activation.cleanup();

    assert.deepEqual([...activation.disposed].sort(), [
      'source:terminal',
      'terminal',
    ]);
  });

  test('a refused tool registration leaves the input registration in place', async (t) => {
    const activation = await activateWith({ views: true, refuseTool: true });
    t.after(activation.cleanup);

    assert.equal(activation.failures.length, 1);
    assert.deepEqual(activation.tools, []);
    assert.deepEqual(
      activation.inputs.map(({ source }) => source),
      ['terminal'],
    );
    assert.deepEqual(activation.disposed, []);
  });

  test('a refused input registration leaves the tool registration in place', async (t) => {
    const activation = await activateWith({ views: true, refuseInput: true });
    t.after(activation.cleanup);

    assert.equal(activation.failures.length, 1);
    assert.deepEqual(activation.inputs, []);
    assert.deepEqual(
      activation.tools.map(({ toolName }) => toolName),
      ['terminal'],
    );
    assert.deepEqual(activation.disposed, []);
  });

  test('without chat.views/v1 it still defines its chat elements and registers nothing', async (t) => {
    const activation = await activateWith({ views: false });
    t.after(activation.cleanup);

    assert.ok(activation.defined.includes('terminal-tool-call'));
    assert.ok(activation.defined.includes('terminal-result'));
    assert.deepEqual(activation.tools, []);
    assert.deepEqual(activation.inputs, []);
    assert.deepEqual(activation.failures, []);
  });
});
