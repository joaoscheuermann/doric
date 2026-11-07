// PC24, PC26 (papercraft-openui.md D6, D15, D16): the program frame's runtime,
// `startProgramFrame`, driven as the app drives it: a happy-dom window is the
// frame, the app's end of a real `MessageChannel` arrives with the protocol-2
// `connect`, and every frame message must parse with the app's
// `frameMessage(…, 2)`. The repository library and the `Export` module are
// fixture modules imported for real (`support/program-library.ts`,
// `support/program-export.ts`); `startProgramFrame` gets sheets of its own,
// since no test may import the `.css` text imports of `sheets.ts`.
//
// Contract matrix:
// - named statements are wrapped (`data-papercraft-statement`,
//   `data-papercraft-component`), inline components are not;
// - scene nodes carry their nearest wrapper's names, and a statement's
//   bounds are the union of its children's boxes;
// - local state only: a button's action posts nothing; `Query` draws and
//   reports nothing;
// - `theme` sets the `dark` class and no `data-openui-theme`; the sheets are
//   `<style>` elements;
// - `Export` mounts its module with `{ theme, args }`; a key that arrives
//   later replaces its placeholder; a new `program` keeps local state;
// - a library of another shim ABI is left out: built-ins only, and an error;
// - `errors` is sent again with `[]` once the program has none;
// - the library's `Harness` renders once per `program`, around everything.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProgramFrameMessage } from '../../src/client/frame-protocol.js';
import {
  type Frame,
  openFrame,
  placeAt,
  programKind,
} from './support/frame-harness.js';

type ProgramFrame = Frame<ProgramFrameMessage>;

const isScene = programKind('scene');
const isErrors = programKind('errors');
const isError = programKind('error');

let runs = 0;

/** The fixture library's URL for a variant, a fresh instance per call. */
const libraryUrl = (query: Record<string, string> = {}): string => {
  runs += 1;
  const url = new URL('./support/program-library.js', import.meta.url);
  url.search = new URLSearchParams({
    ...query,
    run: String(runs),
  }).toString();

  return url.href;
};

const EXPORT_URL = new URL('./support/program-export.js', import.meta.url).href;

/** Runs `body` with a protocol-2 frame, closing it and checking every message parsed. */
const withFrame = async (
  body: (frame: ProgramFrame) => Promise<void>,
  sheets: readonly string[] = [],
): Promise<void> => {
  const frame = await openFrame({ protocol: 2, sheets });

  try {
    await body(frame);
    assert.deepEqual(frame.invalid, [], 'every frame message parses');
  } finally {
    await frame.close();
  }
};

const init = (
  frame: ProgramFrame,
  options: {
    readonly library?: string;
    readonly theme?: 'light' | 'dark';
  } = {},
): void =>
  frame.send({
    kind: 'init',
    theme: options.theme ?? 'light',
    capture: 'none',
    ...(options.library === undefined
      ? {}
      : { library: { module: options.library } }),
  });

const program = (
  frame: ProgramFrame,
  text: string,
  exports: Readonly<Record<string, { readonly module: string }>> = {},
  streaming = false,
): void => frame.send({ kind: 'program', text, streaming, exports });

/** Polls the frame until `read()` holds. */
const until = async <T>(
  frame: ProgramFrame,
  read: () => T,
  holds: (value: T) => boolean,
  message: string,
): Promise<T> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();

    if (holds(value)) return value;
    await frame.settle();
  }

  throw new Error(message);
};

const $ = (frame: ProgramFrame, selector: string) =>
  frame.document.querySelector(selector);
const $$ = (frame: ProgramFrame, selector: string) => [
  ...frame.document.querySelectorAll(selector),
];

const wrapper = (statement: string) =>
  `[data-papercraft-statement="${statement}"]`;

test('PC24: a named statement is wrapped with its statement and component; an inline one is not', async () => {
  await withFrame(async (frame) => {
    init(frame);
    program(
      frame,
      [
        'root = Stack([title, Card([TextContent("inline text")])])',
        'title = TextContent("Hello")',
      ].join('\n'),
    );

    const title = await until(
      frame,
      () => $(frame, wrapper('title')),
      (found) => found !== null,
      'the statement `title` was never wrapped',
    );
    assert.equal(
      title?.getAttribute('data-papercraft-component'),
      'TextContent',
    );
    assert.equal((title as HTMLElement).style.display, 'contents');
    assert.ok(title?.textContent?.includes('Hello'));
    assert.equal(
      $(frame, wrapper('root'))?.getAttribute('data-papercraft-component'),
      'Stack',
    );

    // The inline Card and its TextContent have no statement: no wrapper.
    const components = $$(frame, '[data-papercraft-statement]').map((one) =>
      one.getAttribute('data-papercraft-component'),
    );
    assert.deepEqual(components.sort(), ['Stack', 'TextContent']);
  });
});

test("PC24: each scene node carries its nearest wrapper's names, and a statement's bounds are the union of its children", async () => {
  await withFrame(async (frame) => {
    init(frame, { library: libraryUrl() });
    program(
      frame,
      ['root = Stack([pair])', 'pair = Pair("left", "right")'].join('\n'),
    );

    await until(
      frame,
      () => $(frame, '.pair-right'),
      (found) => found !== null,
      'the library component never rendered',
    );
    placeAt($(frame, '.pair-left'), { x: 10, y: 20, width: 30, height: 10 });
    placeAt($(frame, '.pair-right'), { x: 50, y: 25, width: 20, height: 40 });

    const from = frame.messages.length;
    frame.send({ kind: 'measure' });
    const scene = await frame.waitFor(isScene, from);

    const left = scene.nodes.find((node) => node.classes.includes('pair-left'));
    assert.equal(left?.statement, 'pair');
    assert.equal(left?.component, 'Pair');
    assert.ok(
      scene.nodes.every((node) => !('stamp' in node)),
      'protocol 2 carries no stamp',
    );
    assert.ok(
      scene.nodes.some(
        (node) =>
          node.statement === 'pair' &&
          node.bounds.x === 10 &&
          node.bounds.y === 20 &&
          node.bounds.width === 60 &&
          node.bounds.height === 45,
      ),
      `no node of \`pair\` spans both boxes: ${JSON.stringify(scene.nodes)}`,
    );
  });
});

test("PC24: a button's action posts nothing toward the conversation", async () => {
  await withFrame(async (frame) => {
    init(frame);
    program(
      frame,
      [
        'root = Stack([ask])',
        'ask = Button("Tell me more", @ToAssistant("Tell me more"))',
      ].join('\n'),
    );

    const button = await until(
      frame,
      () => $(frame, `${wrapper('ask')} button`) as HTMLButtonElement | null,
      (found) => found !== null,
      'the button never rendered',
    );
    const before = frame.messages.length;
    button?.click();
    await frame.settle();
    await frame.settle();

    const after = frame.messages.slice(before).map((message) => message.kind);
    assert.ok(
      after.every((kind) =>
        ['scene', 'size', 'pointer', 'focus'].includes(kind),
      ),
      `the click posted ${JSON.stringify(after)}`,
    );
  });
});

test('PC24: a Query statement draws nothing and posts no errors entry', async () => {
  await withFrame(async (frame) => {
    init(frame);
    program(
      frame,
      [
        'root = Stack([shown])',
        'data = Query("list_orders", {}, {rows: []})',
        'shown = TextContent("orders")',
      ].join('\n'),
    );

    await until(
      frame,
      () => $(frame, wrapper('shown')),
      (found) => found !== null,
      'the program never rendered',
    );
    await frame.settle();

    assert.equal(
      frame.document.body.textContent?.includes('list_orders'),
      false,
    );
    const reported = frame.messages
      .filter(isErrors)
      .flatMap((message) => message.errors);
    assert.deepEqual(
      reported.filter((error) => error.statementId === 'data'),
      [],
    );
  });
});

test('PC24: `theme` sets the dark class on <html> and no data-openui-theme', async () => {
  await withFrame(async (frame) => {
    init(frame);
    program(frame, 'root = Stack([TextContent("hi")])');
    frame.send({ kind: 'theme', theme: 'dark' });

    await until(
      frame,
      () => frame.document.documentElement.classList.contains('dark'),
      (dark) => dark,
      'the theme never reached <html>',
    );
    assert.equal(frame.document.querySelector('[data-openui-theme]'), null);

    frame.send({ kind: 'theme', theme: 'light' });
    await until(
      frame,
      () => frame.document.documentElement.classList.contains('dark'),
      (dark) => !dark,
      'the light theme never came back',
    );
  });
});

test('PC24: startProgramFrame loads each of its sheets as a <style> element', async () => {
  const sheets = [
    ':root { --doric-test-a: 1px; }',
    '@layer openui { .test-b { color: red; } }',
    ':root { --openui-test-c: 2px; }',
  ];

  await withFrame(async (frame) => {
    const styles = $$(frame, 'style').map((style) => style.textContent);

    for (const sheet of sheets) {
      assert.ok(styles.includes(sheet), `no <style> holds ${sheet}`);
    }
    assert.equal(
      $$(frame, 'link[rel="stylesheet"]').length,
      0,
      'the sheets are inline, not linked',
    );
  }, sheets);
});

test('PC24: an Export mounts its module with { theme, args }, and a key that arrives later replaces its placeholder', async () => {
  await withFrame(async (frame) => {
    init(frame, { theme: 'dark' });
    const text = [
      'root = Stack([card])',
      'card = Export("src/Card.tsx", "Primary", {label: "Pay now"})',
    ].join('\n');

    program(frame, text);
    await until(
      frame,
      () => $(frame, wrapper('card')),
      (found) => found !== null,
      'the Export statement never rendered',
    );
    assert.equal(
      $(frame, '.export-mounted'),
      null,
      'not built yet: a placeholder',
    );

    program(frame, text, { 'src/Card.tsx#Primary': { module: EXPORT_URL } });
    const mounted = await until(
      frame,
      () => $(frame, `${wrapper('card')} .export-mounted`),
      (found) => found !== null,
      'the built export never mounted',
    );
    assert.equal(mounted?.getAttribute('data-theme'), 'dark');
    assert.deepEqual(JSON.parse(mounted?.getAttribute('data-args') ?? 'null'), {
      label: 'Pay now',
    });
  });
});

test('PC24: a second program with the same text and a new exports key keeps local state', async () => {
  await withFrame(async (frame) => {
    init(frame);
    const text = [
      'root = Stack([name, show, shown, card])',
      'name = Input("name", "Your name")',
      'show = Button("Show", @Set($open, true))',
      'shown = $open ? TextContent("opened") : TextContent("closed")',
      'card = Export("src/Card.tsx")',
    ].join('\n');

    program(frame, text);
    const input = await until(
      frame,
      () => $(frame, `${wrapper('name')} input`) as HTMLInputElement | null,
      (found) => found !== null,
      'the Input never rendered',
    );
    const view = frame.win as unknown as {
      HTMLInputElement: typeof HTMLInputElement;
      Event: typeof Event;
    };
    // react-dom loads here without a global window, so it reads typing
    // through its old-IE path: `focusin` starts watching the field (with
    // `attachEvent`, which happy-dom lacks) and `keyup` reports the change.
    Object.assign(input as object, {
      attachEvent: () => undefined,
      detachEvent: () => undefined,
    });
    input?.dispatchEvent(new view.Event('focusin', { bubbles: true }));
    Object.getOwnPropertyDescriptor(
      view.HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, 'Ada');
    input?.dispatchEvent(new view.Event('keyup', { bubbles: true }));
    input?.dispatchEvent(new view.Event('focusout', { bubbles: true }));
    (
      $(frame, `${wrapper('show')} button`) as HTMLButtonElement | null
    )?.click();
    // `shown` picks its element by a ternary at render time, so it has no
    // wrapper of its own (D6); its text is read through `root`'s wrapper.
    const rootText = () => $(frame, wrapper('root'))?.textContent ?? '';
    await until(
      frame,
      rootText,
      (shown) => shown.includes('opened') && !shown.includes('closed'),
      '@Set never changed $open',
    );
    assert.equal(input?.value, 'Ada', 'the typed name reached the field state');

    program(frame, text, { 'src/Card.tsx#': { module: EXPORT_URL } });
    await until(
      frame,
      () => $(frame, '.export-mounted'),
      (found) => found !== null,
      'the export never mounted',
    );

    assert.equal(
      ($(frame, `${wrapper('name')} input`) as HTMLInputElement | null)?.value,
      'Ada',
    );
    assert.ok(rootText().includes('opened'), '$open is still true');
    assert.ok(!rootText().includes('closed'), '$open was not reset');
  });
});

test('PC24: a library of another shim ABI is left out: built-ins draw, and the frame posts the error', async () => {
  await withFrame(async (frame) => {
    init(frame, { library: libraryUrl({ abi: 'stale' }) });
    program(
      frame,
      [
        'root = Stack([title, hi])',
        'title = TextContent("Built-in")',
        'hi = Greeting("Ada")',
      ].join('\n'),
    );

    await until(
      frame,
      () => $(frame, wrapper('title'))?.textContent ?? '',
      (shown) => shown.includes('Built-in'),
      'the built-ins never drew',
    );
    await frame.waitFor(isError);
    assert.equal($(frame, '.greeting'), null, 'the library was used');
  });
});

test('PC24: `errors` follows with [] once the program no longer has any', async () => {
  await withFrame(async (frame) => {
    init(frame);
    program(
      frame,
      ['root = Stack([bad])', 'bad = NoSuchThing("x")'].join('\n'),
    );

    const first = await frame.waitFor(
      (message): message is Extract<ProgramFrameMessage, { kind: 'errors' }> =>
        isErrors(message) && message.errors.length > 0,
    );
    assert.ok(first.errors.length > 0);

    const from = frame.messages.length;
    program(
      frame,
      ['root = Stack([bad])', 'bad = TextContent("x")'].join('\n'),
    );
    const cleared = await frame.waitFor(isErrors, from);
    assert.deepEqual(cleared.errors, []);
  });
});

test('PC26: the Harness renders once per program, around the whole output, and every repository component reads its context', async () => {
  const url = libraryUrl({ harness: '1' });

  await withFrame(async (frame) => {
    init(frame, { library: url });
    // The same module instance the frame imports: its render count.
    const library = (await import(url)) as {
      readonly harnessRenders: { readonly count: number };
    };
    program(
      frame,
      [
        'root = Stack([a, Card([b])])',
        'a = Greeting("Ada")',
        'b = Greeting("Grace")',
      ].join('\n'),
    );

    await until(
      frame,
      () => $$(frame, '.greeting').length,
      (count) => count === 2,
      'the repository components never rendered',
    );
    assert.deepEqual(
      $$(frame, '.greeting').map((one) => one.getAttribute('data-context')),
      ['from-harness', 'from-harness'],
    );
    await frame.settle();
    assert.equal(library.harnessRenders.count, 1, 'one program, one render');

    program(
      frame,
      [
        'root = Stack([a, Card([b])])',
        'a = Greeting("Ada")',
        'b = Greeting("Lin")',
      ].join('\n'),
    );
    await until(
      frame,
      () => frame.document.body.textContent ?? '',
      (text) => text.includes('Hello, Lin'),
      'the second program never rendered',
    );
    await frame.settle();
    assert.equal(library.harnessRenders.count, 2, 'two programs, two renders');
  });
});
