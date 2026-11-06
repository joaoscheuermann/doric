// PC3, PC27 (papercraft-openui.md D5, D6, D14, D16): a papercraft fence as the
// conversation draws it. The chat mounts the element papercraft registered
// for the `papercraft` tag and hands it the fence; the element asks the host
// for the library bound at the fence's turn, stores the module bytes in the
// desktop cache, boots a protocol-2 frame (a fake, `support/fake-frame.ts`)
// and sends it `init` and `program`; it builds each literal `Export` once and
// reports the program's errors to `openui.programs/v1` with the tag
// `papercraft`. The host's `papercraft.programs/v1`, the desktop's
// `papercraft.cache/v1` and `openui.programs/v1` are doubles at the bridge
// (`support/fence-host.ts`).
//
// Contract matrix (PC3):
// - no `init` before `library` answers; `library` gets the fence's
//   `turnSequence`, and every call the scope `{ projectId, threadId }`;
// - `failed`: built-ins, the error line, never `reportErrors`;
// - `ready`: `init` names the module's `papercraft-modules` URLs once
//   `ensure` stored its bytes; one report at `closed`, tag `papercraft`, the
//   frame's codes only (no frame text, no unknown code, no statement the
//   program lacks);
// - an `Export` build that finishes sends `program` again, same text, with
//   the key; a `read` that stays `not_found` after one retry draws `failed`.
// Contract matrix (PC27):
// - at most 8 distinct keys are built; the ninth shows and reports the
//   limit; a non-literal path and a half-written last line ask no build; a
//   key without a name is `<path>#`; a build failure shows and reports
//   `render-error`, cut to 300 characters.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import type { ProgramAppMessage } from '../../src/client/frame-protocol.js';
import type {
  ExportAnswer,
  LibraryAnswer,
} from '../../src/contracts/programs.js';
import { closeWindow } from './support/dom.js';
import {
  flush,
  type Host,
  type HostOptions,
  MODULES,
  moduleRef,
  PROJECT,
  programFence,
  readyLibrary,
  startHost,
  THREAD,
  until,
  viewOf,
} from './support/fence-host.js';

after(closeWindow);

let hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts) await host.dispose();
  hosts = [];
});

const start = async (options: HostOptions = {}): Promise<Host> => {
  const host = await startHost(options);
  hosts.push(host);

  return host;
};

const SCOPE = { projectId: PROJECT, threadId: THREAD };

type Program = Extract<ProgramAppMessage, { kind: 'program' }>;
type Init = Extract<ProgramAppMessage, { kind: 'init' }>;

/** Every message the app sent the fence's frames, in order. */
const sent = (host: Host): readonly ProgramAppMessage[] =>
  host.frames.all.flatMap((frame) => frame.programReceived);
const inits = (host: Host): readonly Init[] =>
  sent(host).filter((message): message is Init => message.kind === 'init');
const programs = (host: Host): readonly Program[] =>
  sent(host).filter(
    (message): message is Program => message.kind === 'program',
  );

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

interface Reported {
  readonly code: string;
  readonly statementId?: string;
  readonly message?: string;
}

/** The errors of the first `reportErrors` call. */
const firstReportErrors = (host: Host): readonly Reported[] => {
  const [report] = host.calls.reports;
  assert.ok(report !== undefined, 'nothing was reported');

  return (report.input as { readonly errors: readonly Reported[] }).errors;
};

const SIMPLE = [
  'root = Stack([title])',
  'title = TextContent("Settings")',
].join('\n');

test('PC3: no init is sent before library answers, and library gets the fence turn in its scope', async () => {
  const answer = deferred<LibraryAnswer>();
  const host = await start({ library: () => answer.promise });
  const fence = programFence(SIMPLE, { turnSequence: 7 });

  await host.mountFence(viewOf(fence));
  await until(
    () => host.calls.library.length,
    (count) => count > 0,
    'the fence never asked for its library',
  );
  await flush();

  assert.deepEqual(
    inits(host),
    [],
    'an init went out before the library answered',
  );
  assert.deepEqual(host.calls.library[0], {
    input: { turnSequence: 7 },
    scope: SCOPE,
  });

  answer.resolve(readyLibrary('lib7'));
  await until(
    () => inits(host).length,
    (count) => count === 1,
    'no init came once the library answered',
  );
});

test('PC3: a failed library draws built-ins, shows its error, and never reports', async () => {
  const host = await start({
    library: async () => ({
      status: 'failed',
      root: '/workspace/app',
      error: 'The schemas folder does not build: Button.tsx:3 is not a schema',
    }),
  });
  const fence = programFence(
    ['root = Stack([bad])', 'bad = NoSuchThing("x")'].join('\n'),
  );

  const node = await host.mountFence(viewOf(fence));
  const [init] = await until(
    () => inits(host),
    (found) => found.length === 1,
    'the fence never drew with the built-ins',
  );
  assert.equal(init?.library, undefined, 'built-ins only');
  await until(
    () => programs(host).length,
    (count) => count > 0,
    'the program was never sent',
  );
  await until(
    node.text,
    (text) => text.includes('Button.tsx:3 is not a schema'),
    'the library error is not shown',
  );

  node
    .frame()
    ?.errors([
      { code: 'unknown-component', statementId: 'bad', message: 'NoSuchThing' },
    ]);
  await flush();
  assert.deepEqual(host.calls.reports, []);
});

test('PC3: a ready library is stored in the cache and init names its papercraft-modules URLs', async () => {
  const host = await start({ library: async () => readyLibrary('lib1') });

  await host.mountFence(viewOf(programFence(SIMPLE)));
  const [init] = await until(
    () => inits(host),
    (found) => found.length === 1,
    'no init came',
  );

  assert.deepEqual(init?.library, {
    module: `${MODULES}lib1/index.js`,
    styles: `${MODULES}lib1/index.css`,
  });
  assert.deepEqual(
    host.calls.reads.map((call) => call.input),
    [{ dir: 'lib1' }],
  );
  assert.ok(host.calls.ensures.length > 0, 'nothing was stored in the cache');
  for (const call of host.calls.ensures) assert.deepEqual(call.scope, SCOPE);
  assert.deepEqual(
    host.calls.ensures
      .flatMap(
        (call) =>
          (call.input as { entries: readonly { path: string }[] }).entries,
      )
      .map((entry) => entry.path)
      .sort(),
    ['lib1/index.css', 'lib1/index.js'],
  );
  for (const call of [...host.calls.library, ...host.calls.reads])
    assert.deepEqual(call.scope, SCOPE);
});

test("PC3: with a ready library, a closed fence reports once, tag papercraft, the frame's codes without its text", async () => {
  const host = await start();
  const fence = programFence(
    [
      'root = Stack([bad, ok])',
      'bad = NoSuchThing("x")',
      'ok = TextContent("ok")',
    ].join('\n'),
  );

  const node = await host.mountFence(viewOf(fence));
  await until(
    () => programs(host).length,
    (count) => count > 0,
    'the program was never sent',
  );
  node.frame()?.errors([
    {
      code: 'unknown-component',
      statementId: 'bad',
      message: 'the frame says: NoSuchThing is unknown',
    },
    { code: 'not-an-openui-code', statementId: 'bad', message: 'x' },
    { code: 'unknown-component', statementId: 'ghost', message: 'y' },
  ]);
  await until(
    () => host.calls.reports.length,
    (count) => count > 0,
    'the closed fence never reported',
  );
  node.frame()?.errors([]);
  await flush();

  assert.equal(host.calls.reports.length, 1, 'reported once');
  const [report] = host.calls.reports;
  assert.deepEqual(report?.scope, SCOPE);
  const input = report?.input as {
    tag: string;
    key: string;
    identity: string;
    revision: number;
    state: string;
    errors: readonly { code: string; statementId?: string; message?: string }[];
  };
  assert.equal(input.tag, 'papercraft');
  assert.equal(input.key, fence.key);
  assert.equal(input.identity, 'settings');
  assert.equal(input.revision, 1);
  assert.equal(input.state, 'closed');
  assert.deepEqual(
    input.errors.filter((error) => error.code === 'unknown-component'),
    [{ code: 'unknown-component', statementId: 'bad' }],
  );
  assert.ok(input.errors.every((error) => error.code !== 'not-an-openui-code'));
  assert.ok(input.errors.every((error) => error.statementId !== 'ghost'));
  assert.ok(
    JSON.stringify(input).includes('the frame says') === false,
    "the frame's text went to the host",
  );
});

test('PC3: an Export build that finishes sends the same program again with its key', async () => {
  const built = deferred<ExportAnswer>();
  const host = await start({ export: () => built.promise });
  const text = [
    'root = Stack([card])',
    'card = Export("src/Card.tsx", "Primary")',
  ].join('\n');

  await host.mountFence(viewOf(programFence(text)));
  const [first] = await until(
    () => programs(host),
    (found) => found.length > 0,
    'the program was never sent',
  );
  assert.deepEqual(first?.exports, {});
  assert.deepEqual(
    host.calls.exports.map((call) => call.input),
    [{ path: 'src/Card.tsx', name: 'Primary' }],
  );

  built.resolve({ status: 'ready', module: moduleRef('card1', false) });
  const again = await until(
    () => programs(host).at(-1),
    (last) => last !== undefined && 'src/Card.tsx#Primary' in last.exports,
    'the built export never reached the frame',
  );
  assert.equal(again?.text, first?.text);
  assert.deepEqual(again?.exports['src/Card.tsx#Primary'], {
    module: `${MODULES}card1/index.js`,
  });
  for (const call of host.calls.exports) assert.deepEqual(call.scope, SCOPE);
});

test('PC3: a read that stays not_found after one retry draws the fence failed', async () => {
  const host = await start({
    read: async () => {
      throw new ContractError('not_found', 'no memo key holds the dir');
    },
  });

  const node = await host.mountFence(viewOf(programFence(SIMPLE)));
  await until(
    node.text,
    (text) => text.includes('The module could not be read from the host'),
    'the fence never said the module could not be read',
  );

  assert.equal(host.calls.library.length, 2, 'library was asked again, once');
  const [init] = await until(
    () => inits(host),
    (found) => found.length === 1,
    'the failed fence never drew with the built-ins',
  );
  assert.equal(init?.library, undefined);
});

test('PC27: a ninth distinct Export shows the limit and is reported as runtime-error; only eight build', async () => {
  const host = await start();
  const statements = Array.from(
    { length: 9 },
    (_, index) => `e${String(index)} = Export("src/E${String(index)}.tsx")`,
  );
  const fence = programFence(
    [
      `root = Stack([${statements.map((_, index) => `e${String(index)}`).join(', ')}])`,
      ...statements,
    ].join('\n'),
  );

  const node = await host.mountFence(viewOf(fence));
  await until(
    () => programs(host).length,
    (count) => count > 0,
    'the program was never sent',
  );
  await until(
    node.text,
    (text) => text.includes('Too many exports in one program'),
    'the ninth Export shows no limit',
  );
  node.frame()?.errors([]);
  await until(
    () => host.calls.reports.length,
    (count) => count > 0,
    'the closed fence never reported',
  );

  assert.deepEqual(
    host.calls.exports.map((call) => (call.input as { path: string }).path),
    Array.from({ length: 8 }, (_, index) => `src/E${String(index)}.tsx`),
  );
  const errors = firstReportErrors(host);
  assert.deepEqual(
    errors.filter((error) => error.code === 'runtime-error'),
    [
      {
        code: 'runtime-error',
        statementId: 'e8',
        message: 'Too many exports in one program: at most 8.',
      },
    ],
  );
});

test('PC27: an Export whose path is not a literal asks no build and stays a placeholder', async () => {
  const host = await start();
  const text = [
    'root = Stack([card])',
    'where = "src/Card.tsx"',
    'card = Export(where)',
  ].join('\n');

  await host.mountFence(viewOf(programFence(text)));
  const [first] = await until(
    () => programs(host),
    (found) => found.length > 0,
    'the program was never sent',
  );
  await flush();

  assert.deepEqual(host.calls.exports, []);
  assert.deepEqual(first?.exports, {});
});

test('PC27: an Export without a name is built and sent under `<path>#`', async () => {
  const host = await start({
    export: async () => ({
      status: 'ready',
      module: moduleRef('plain', false),
    }),
  });
  const text = ['root = Stack([card])', 'card = Export("src/Card.tsx")'].join(
    '\n',
  );

  await host.mountFence(viewOf(programFence(text)));
  const last = await until(
    () => programs(host).at(-1),
    (message) => message !== undefined && 'src/Card.tsx#' in message.exports,
    'the export never reached the frame under `src/Card.tsx#`',
  );

  assert.deepEqual(
    host.calls.exports.map((call) => call.input),
    [{ path: 'src/Card.tsx' }],
  );
  assert.deepEqual(last?.exports['src/Card.tsx#'], {
    module: `${MODULES}plain/index.js`,
  });
});

test('PC27: a build failure shows its error in the node and is reported as render-error, cut to 300', async () => {
  const error = `Cannot resolve ./missing ${'x'.repeat(400)}`;
  const host = await start({
    export: async () => ({ status: 'failed', error }),
  });
  const text = [
    'root = Stack([card])',
    'card = Export("src/Card.tsx", "Primary")',
  ].join('\n');

  const node = await host.mountFence(viewOf(programFence(text)));
  await until(
    node.text,
    (shown) => shown.includes('Cannot resolve ./missing'),
    'the build failure is not shown in the node',
  );
  node.frame()?.errors([]);
  await until(
    () => host.calls.reports.length,
    (count) => count > 0,
    'the closed fence never reported',
  );

  const errors = firstReportErrors(host);
  const render = errors.filter((one) => one.code === 'render-error');
  assert.equal(render.length, 1);
  assert.equal(render[0]?.statementId, 'card');
  assert.ok(
    render[0]?.message?.startsWith(
      'Export src/Card.tsx#Primary did not build: Cannot resolve ./missing',
    ),
    render[0]?.message,
  );
  assert.ok((render[0]?.message?.length ?? 0) <= 300);
});

test('PC27: a streaming fence whose last line is a half-written Export asks no build', async () => {
  const host = await start();
  const fence = programFence(
    [
      'root = Stack([title, card])',
      'title = TextContent("Settings")',
      'card = Export("apps/w',
    ].join('\n'),
    { state: 'streaming' },
  );

  await host.mountFence(viewOf(fence));
  await until(
    () => programs(host).length,
    (count) => count > 0,
    'the streaming program was never sent',
  );
  await flush();

  assert.deepEqual(host.calls.exports, []);
  assert.equal(programs(host).at(-1)?.streaming, true);
});
