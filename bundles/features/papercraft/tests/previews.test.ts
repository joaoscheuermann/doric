// The preview builder and reader (path A): a fixture source becomes a
// self-contained markup with a stable sha, every element carries the origin
// stamp the comment anchor's `source` form reads (`path:line`), and `read`
// serves the markup a revision froze — its stored built files — so an old
// revision keeps its reading after the source changed; only a revision
// without stored bytes falls back to the live source, and says so.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactRevisionRead } from '../src/contracts/index.js';
import {
  buildPreview,
  deriveMarkup,
  readPreview,
  sha256,
  stampRoot,
  stampSource,
} from '../src/host/previews.js';
import { servicesFor, testCall } from './support/services.js';

const FIXTURE = '<h1 id="title">Checkout</h1>\n<p>Pagar</p>';

const filesFor = (content: string) => ({
  content: async ({ path }: { readonly path: string }) =>
    ({
      status: 'ready',
      value: {
        status: 'read',
        path,
        content,
        truncated: false,
        binary: false,
      },
    }) as const,
});

const baseRecord = {
  artifactId: 'checkout-7f3a',
  kind: 'preview',
  title: 'Checkout',
  revision: 1,
  revisions: 1,
  targets: [{ path: 'src/checkout.html' }],
  source: 'html',
  path: 'src/checkout.html',
  state: 'open',
  createdAt: '2024-01-01T00:00:00Z',
} as const;

const recordWith = (entries: readonly unknown[]): ArtifactRevisionRead =>
  ({
    ...baseRecord,
    entries,
  }) as unknown as ArtifactRevisionRead;

const b64 = (markup: string): string =>
  Buffer.from(markup, 'utf8').toString('base64');

test('a plain fragment is wrapped, and each element stamped with path:line', () => {
  const markup = deriveMarkup('html', 'src/checkout.html', FIXTURE);

  assert.match(markup, /<!DOCTYPE html>/);
  // The fragment's own elements carry where they came from: the file and the
  // line the element starts on, which is what the `source` anchor parses.
  assert.match(
    markup,
    /<h1 data-papercraft-source="src\/checkout\.html:1" id="title">Checkout<\/h1>/,
  );
  assert.match(
    markup,
    /<p data-papercraft-source="src\/checkout\.html:2">Pagar<\/p>/,
  );
  // The wrapper is the build's own, not the source's: it carries no stamp.
  assert.doesNotMatch(markup, /<html data-papercraft-source=/);
});

test('an html document is kept as it is, with every element stamped', () => {
  const document = `<!DOCTYPE html>\n<html>\n<body>${FIXTURE}</body></html>`;
  const markup = deriveMarkup('html', 'index.html', document);

  assert.match(markup, /<html data-papercraft-source="index\.html:2">/);
  assert.match(markup, /<body data-papercraft-source="index\.html:3">/);
  // `stampRoot` is idempotent: an already stamped root keeps its origin.
  assert.equal(stampRoot(markup, 'index.html:2'), markup);
});

test('stamping stays out of comments, raw text and quoted values', () => {
  const source = [
    '<!-- <p>um comentário não é elemento</p> -->',
    '<script>const markup = "<p>não carimbe</p>";</script>',
    '<button title="Fechar > abrir">Fechar</button>',
    '<img src="x.png" alt="um">',
    '<div data-papercraft-source="hand.html:9">pré-carimbado</div>',
    '<input disabled>',
    '<br/>',
  ].join('\n');

  const stamped = stampSource(source, 'page.html');

  // Elements the source wrote get the file and their own line.
  assert.match(stamped, /<script data-papercraft-source="page\.html:2">/);
  assert.match(stamped, /<button data-papercraft-source="page\.html:3"/);
  assert.match(stamped, /<img data-papercraft-source="page\.html:4"/);
  assert.match(stamped, /<input data-papercraft-source="page\.html:6"/);
  assert.match(stamped, /<br data-papercraft-source="page\.html:7"\/>/);
  // What the source did not write keeps no stamp, and an existing stamp
  // survives: the build never invents an origin.
  assert.doesNotMatch(stamped, /comentário data-papercraft-source/);
  assert.match(stamped, /não carimbe/);
  assert.doesNotMatch(stamped, /não carimbe.{0,40}data-papercraft-source/);
  assert.doesNotMatch(stamped, /<p data-papercraft-source="page\.html:\d">/);
  assert.match(
    stamped,
    /<div data-papercraft-source="hand\.html:9">pré-carimbado<\/div>/,
  );
});

test('a document behind a long leading comment is kept as a document', () => {
  const banner = `<!-- ${'licença '.repeat(80)} -->`;
  const markup = deriveMarkup(
    'html',
    'page.html',
    `${banner}\n<!DOCTYPE html>\n<html><body><p>oi</p></body></html>`,
  );

  // Not wrapped a second time: one doctype, the source's own.
  assert.equal(markup.match(/<!DOCTYPE html>/gi)?.length, 1);
  assert.match(markup, /<html data-papercraft-source="page\.html:3">/);
});

test('the text of title and textarea is never stamped', () => {
  const stamped = stampSource(
    '<title><b>t</b></title>\n<textarea><p>texto</p></textarea>',
    'page.html',
  );

  assert.match(
    stamped,
    /<title data-papercraft-source="page\.html:1"><b>t<\/b>/,
  );
  assert.match(stamped, /<p>texto<\/p>/);
  assert.doesNotMatch(stamped, /<b data-papercraft-source/);
  assert.doesNotMatch(stamped, /<p data-papercraft-source/);
});

test('the builder answers the built files with a sha of the markup', async () => {
  const services = servicesFor((id) =>
    id === 'files/v1' ? filesFor(FIXTURE) : undefined,
  );

  const built = await buildPreview(services, testCall, {
    path: 'src/checkout.html',
    source: 'html',
  });

  assert.equal(built.files.length, 1);
  assert.equal(built.files[0]?.path, 'index.html');
  assert.equal(
    built.files[0]?.sha256,
    sha256(deriveMarkup('html', 'src/checkout.html', FIXTURE)),
  );
});

test('read serves the markup a revision froze, not the edited source', async () => {
  const frozen = deriveMarkup('html', 'src/checkout.html', FIXTURE);
  const record = recordWith([
    { path: 'index.html', sha256: sha256(frozen), base64: b64(frozen) },
  ]);
  // The source changed after the revision: an edit the reading must not see.
  const services = servicesFor((id) => {
    if (id === 'files/v1') return filesFor('<h1>Editado</h1>');
    if (id === 'artifacts/v1') return { read: async () => record };

    return undefined;
  });

  const state = await readPreview(services, testCall, {
    artifactId: 'checkout-7f3a',
    revision: 1,
  });

  assert.equal(state?.markup, frozen);
  assert.match(state?.markup ?? '', /Checkout<\/h1>/);
  assert.doesNotMatch(state?.markup ?? '', /Editado/);
  // The stored reading is the revision's own: no fallback was needed.
  assert.equal(state?.derived, undefined);
  assert.deepEqual(state?.files, [
    { path: 'index.html', sha256: sha256(frozen) },
  ]);
});

test('read serves the markup of a component revision, not its module', async () => {
  const frozen = deriveMarkup('component', 'src/Card.tsx', 'export default 1;');
  const module = 'export function mount() {}';
  const sheet = '.p-4 { padding: 1rem; }';
  // The module's bytes come first: the markup is the `index.html` entry,
  // wherever the registry lists it.
  const record = recordWith([
    { path: 'index.js', sha256: sha256(module), base64: b64(module) },
    { path: 'index.css', sha256: sha256(sheet), base64: b64(sheet) },
    { path: 'index.html', sha256: sha256(frozen), base64: b64(frozen) },
  ]);
  const services = servicesFor((id) => {
    if (id === 'files/v1') return filesFor('export default 2;');
    if (id === 'artifacts/v1') return { read: async () => record };

    return undefined;
  });

  const state = await readPreview(services, testCall, {
    artifactId: 'checkout-7f3a',
    revision: 1,
  });

  assert.equal(state?.markup, frozen);
  assert.equal(state?.derived, undefined);
  assert.deepEqual(
    state?.files.map((file) => file.path),
    ['index.js', 'index.css', 'index.html'],
  );
});

test('read falls back to the live source when nothing was stored', async () => {
  const record = recordWith([{ path: 'index.html', sha256: 'a'.repeat(64) }]);
  const services = servicesFor((id) => {
    if (id === 'files/v1') return filesFor(FIXTURE);
    if (id === 'artifacts/v1') return { read: async () => record };

    return undefined;
  });

  const state = await readPreview(services, testCall, {
    artifactId: 'checkout-7f3a',
    revision: 1,
  });

  assert.equal(
    state?.markup,
    deriveMarkup('html', 'src/checkout.html', FIXTURE),
  );
  assert.equal(state?.derived, true);
  assert.deepEqual(state?.files, builtOf(state?.markup ?? ''));
});

test('read re-derives when the revision recorded no entries at all', async () => {
  const record = recordWith([]);
  const services = servicesFor((id) => {
    if (id === 'files/v1') return filesFor(FIXTURE);
    if (id === 'artifacts/v1') return { read: async () => record };

    return undefined;
  });

  const state = await readPreview(services, testCall, {
    artifactId: 'checkout-7f3a',
    revision: 1,
  });

  assert.equal(state?.derived, true);
  assert.match(state?.markup ?? '', /Checkout<\/h1>/);
});

test('read answers undefined for an unknown artifact', async () => {
  const services = servicesFor((id) =>
    id === 'artifacts/v1' ? { read: async () => undefined } : filesFor(FIXTURE),
  );

  assert.equal(
    await readPreview(services, testCall, {
      artifactId: 'missing',
      revision: 1,
    }),
    undefined,
  );
});

/** The built file list of one markup, as `read` answers it. */
const builtOf = (markup: string): { path: string; sha256: string }[] => [
  { path: 'index.html', sha256: sha256(markup) },
];
