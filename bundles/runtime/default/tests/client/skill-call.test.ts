// The `default-skill-call` element (bundle isolation 5(b), change 2): the
// block of a `load_skill` call, moved from the chat's
// `components/molecules/skill-tool-item.tsx` and registered through
// `chat.views/v1` 1.2.0.
// - AC5.3: the drawing's cases, moved from the chat's
//   `tests/client/skill-tool-item.test.ts`, mount the element alone with the
//   `view` the chat sets for the case's call (no chat window, no chat built
//   part) and keep their assertions on what the block draws. The source label
//   follows U15: `mcp/acme/…` reads `mcp · acme`.
// - O2: the element's `toggle()` reports the opposite of what the block
//   shows; a failed load shows open, a loaded one folded.
// - `:1044`: the client part defines the tag and registers `load_skill`,
//   standalone, in a `whenAvailable` callback; its cleanup disposes it.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { ChatToolView, ToolRendererSpec } from 'chat/contracts';
import { errorInfo } from 'desktop/reads';

import { assertToolNotice } from './support/notices.js';
import {
  installWindow,
  type MountedElement,
  mountElement,
  settle,
} from './support/render.js';
import { fakeServices } from './support/services.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const failedAt = '2026-01-01T00:00:03.000Z';

/** The skill's instructions, Markdown the block must show as plain text. */
const skillText = [
  '# Behavioral Testing',
  '',
  'Write tests from **public behavior**, not from the implementation.',
].join('\n');

/** The `view` the chat sets on the element for one `load_skill` call. */
const callView = (input: {
  readonly name: string;
  readonly status: ChatToolView['status'];
  readonly result?: string;
  readonly error?: ChatToolView['error'];
  readonly chosen?: boolean | null;
}): ChatToolView => ({
  projectId,
  threadId,
  promptId,
  key: `${promptId}/call-skill`,
  name: 'load_skill',
  args: JSON.stringify({ name: input.name }),
  ...(input.result === undefined ? {} : { result: input.result }),
  ...(input.error === undefined ? {} : { error: input.error }),
  status: input.status,
  chosen: input.chosen ?? null,
  focused: false,
});

const loading = (name: string): ChatToolView =>
  callView({ name, status: 'running' });
const loaded = (name: string, chosen: boolean | null = null): ChatToolView =>
  callView({ name, status: 'finished', result: skillText, chosen });
const failed = (name: string): ChatToolView =>
  callView({
    name,
    status: 'failed',
    error: errorInfo(
      { message: `No skill is named ${name}.` },
      { at: failedAt },
    ),
  });

let mounted: MountedElement<ChatToolView> | undefined;

afterEach(() => {
  mounted?.cleanup();
  mounted = undefined;
});

/** Mounts `default-skill-call` alone with `view`, as the chat creates it. */
const mountSkillCall = async (
  view: ChatToolView,
): Promise<MountedElement<ChatToolView>> => {
  installWindow();
  const { SKILL_CALL_TAG, defineSkillCallElement } = await import(
    '../../src/client/skill-call.js'
  );
  mounted = await mountElement(SKILL_CALL_TAG, defineSkillCallElement(), {
    services: fakeServices().services,
    view,
  });
  return mounted;
};

const textOf = (element: HTMLElement): string => element.textContent ?? '';

describe('the load_skill block, mounted alone (AC5.3)', () => {
  test('a loading skill call says it is loading the skill it names', async () => {
    const { element } = await mountSkillCall(loading('git-cloning'));

    assert.match(textOf(element), /Loading skill\s+git-cloning/);
    assert.match(textOf(element), /built-in/);
  });

  test('a loaded workspace skill folds away, and opening it shows its text as written', async () => {
    const call = await mountSkillCall(loaded('cwd/behavioral-testing'));
    const { element } = call;

    assert.match(textOf(element), /Loaded skill\s+behavioral-testing/);
    assert.match(textOf(element), /workspace/);
    // The locator's prefix is the source's business, not the skill's name.
    assert.doesNotMatch(textOf(element), /cwd\//);
    // Folded: the skill's instructions are the block's detail, and not drawn.
    assert.doesNotMatch(textOf(element), /public behavior/);

    element
      .querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
      ?.click();
    await settle();
    assert.deepEqual(call.chosen, [true], 'the header reports chosen true');
    await call.setView(loaded('cwd/behavioral-testing', true));

    // Open: the text reads as it was returned, its Markdown markers kept as
    // characters instead of drawn as a heading or bold.
    assert.match(textOf(element), /# Behavioral Testing/);
    assert.match(textOf(element), /\*\*public behavior\*\*/);
    assert.equal(element.querySelector('h1, h2, h3, strong, b'), null);
  });

  test('a skill that failed to load is open with its error', async () => {
    const { element } = await mountSkillCall(failed('cwd/missing-skill'));

    assert.match(textOf(element), /Failed to load skill\s+missing-skill/);
    assert.match(textOf(element), /No skill is named cwd\/missing-skill\./);
  });

  test("an MCP server's skill names its source and group as written (U15)", async () => {
    const { element } = await mountSkillCall(loaded('mcp/acme/refunds'));

    assert.match(textOf(element), /Loaded skill\s+refunds/);
    assert.match(textOf(element), /mcp · acme/);
    assert.doesNotMatch(textOf(element), /MCP · acme/);
    assert.doesNotMatch(textOf(element), /mcp\/acme/);
  });

  test('T-19 a skill that failed to load shows the compact tool notice naming the call', async () => {
    const { element } = await mountSkillCall(failed('cwd/missing-skill'));

    await assertToolNotice(element, {
      title: 'Tool failed',
      explanation: 'No skill is named cwd/missing-skill.',
      tool: 'load_skill',
    });
  });
});

describe('the toggle key on the load_skill block (O2)', () => {
  test('toggle() on a failed load, open on its own, reports chosen false', async () => {
    const call = await mountSkillCall(failed('cwd/missing-skill'));
    assert.equal(typeof call.element.toggle, 'function');

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [false]);
  });

  test('toggle() on a loaded skill, folded on its own, reports chosen true', async () => {
    const call = await mountSkillCall(loaded('cwd/behavioral-testing'));
    assert.equal(typeof call.element.toggle, 'function');

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [true]);
  });

  test("toggle() reports the opposite of the reader's choice the view carries", async () => {
    const call = await mountSkillCall(loaded('cwd/behavioral-testing', true));

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [false]);
  });
});

/** What the default client part's activation asked of its contracts. */
interface Activation {
  readonly defined: readonly string[];
  readonly registered: readonly ToolRendererSpec[];
  readonly disposed: readonly string[];
  /** What the `whenAvailable` callbacks threw, as the platform records it. */
  readonly failures: readonly unknown[];
  readonly cleanup: () => void;
}

/** Activates the default client part over fakes, `chat.views/v1` served or not. */
const activateWith = async (input: {
  readonly views: boolean;
}): Promise<Activation> => {
  installWindow();
  const { activate } = await import('../../src/client/index.js');
  const defined: string[] = [];
  const registered: ToolRendererSpec[] = [];
  const released: string[] = [];
  const { services, failures } = fakeServices({
    'ui/v1': {
      define: (tag: string) => {
        defined.push(tag);
        return { dispose: () => undefined };
      },
    },
    ...(input.views
      ? {
          'chat.views/v1': {
            registerToolRenderer: (spec: ToolRendererSpec) => {
              registered.push(spec);
              return { dispose: () => released.push(spec.toolName) };
            },
            registerInputRenderer: () => ({ dispose: () => undefined }),
          },
        }
      : {}),
  });
  const cleanup = activate({ services } as unknown as Parameters<
    typeof activate
  >[0]);
  return {
    defined,
    registered,
    disposed: released,
    failures,
    cleanup: () => {
      if (typeof cleanup === 'function') cleanup();
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

describe('the default client part registers load_skill with chat.views/v1', () => {
  test('defines default-skill-call and registers load_skill drawn by it, standalone', async (t) => {
    const activation = await activateWith({ views: true });
    t.after(activation.cleanup);

    assert.ok(
      activation.defined.includes('default-skill-call'),
      `defined: ${activation.defined.join(', ')}`,
    );
    assert.deepEqual(activation.registered.map(facts), [
      {
        toolName: 'load_skill',
        elementTag: 'default-skill-call',
        standalone: true,
        openByDefault: false,
      },
    ]);
    assert.deepEqual(activation.failures, []);
  });

  test('the cleanup disposes the registration', async () => {
    const activation = await activateWith({ views: true });
    activation.cleanup();

    assert.deepEqual(activation.disposed, ['load_skill']);
  });

  test('without chat.views/v1 it still defines its element and registers nothing', async (t) => {
    const activation = await activateWith({ views: false });
    t.after(activation.cleanup);

    assert.ok(activation.defined.includes('default-skill-call'));
    assert.deepEqual(activation.registered, []);
    assert.deepEqual(activation.failures, []);
  });
});
