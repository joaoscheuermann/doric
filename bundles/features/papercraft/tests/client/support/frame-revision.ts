// A revision module as the preview frame imports it, with `mount(root, {
// theme })` and the contract of a revision compiled for the frame: one
// `display: contents` container in the root, the story's layout on the root
// as `data-papercraft-layout`, overlays portaled into the document's body.
// It touches only the document it is mounted in (no globals), so the frame
// under test is the one window it sees.
//
// The module URL's `?variant=` picks what it renders:
// - `card` (default): a stamped card with a heading, a link and a button;
// - `padded`: the card, stating Storybook's `padded` layout;
// - `portal`: the card plus a stamped overlay portaled into the body;
// - `many`: 500 sibling spans;
// - `throws`: a mount that throws.
//
// Each mount writes the theme it was given, whether `<html>` was dark, and
// what the frame's storage answered into the DOM, and records its mounts and unmounts on the window
// (`papercraftFixture`), the way a test reads what a revision saw.

interface FixtureLog {
  mounts: string[];
  unmounts: number;
}

const variant = new URL(import.meta.url).searchParams.get('variant') ?? 'card';

const logOf = (view: Window): FixtureLog => {
  const host = view as unknown as { papercraftFixture?: FixtureLog };

  host.papercraftFixture ??= { mounts: [], unmounts: 0 };

  return host.papercraftFixture;
};

const CARD = [
  '<main id="card" class="card  shadow" data-papercraft-source="src/Card.tsx:3">',
  '<h1 data-papercraft-source="src/Card.tsx:4">  Hello\n   world  </h1>',
  '<a id="link" href="https://example.com/" data-papercraft-source="src/Card.tsx:5">Go</a>',
  '<button id="button" type="button">Press</button>',
  '<p id="long">',
  '\n   ',
  'w'.repeat(300),
  '</p>',
  '</main>',
].join('');

export function mount(
  root: HTMLElement,
  options: { readonly theme: 'light' | 'dark' },
): () => void {
  const document = root.ownerDocument;
  const view = document.defaultView as Window;
  const log = logOf(view);

  if (variant === 'throws') throw new Error('mount exploded');

  const app = document.createElement('div');
  app.setAttribute('data-papercraft-root', '');
  app.style.display = 'contents';
  app.setAttribute('data-theme', options.theme);
  // What `<html>` said when the revision mounted (the frame states the
  // theme first).
  app.setAttribute(
    'data-html-dark',
    String(document.documentElement.classList.contains('dark')),
  );
  root.append(app);
  root.setAttribute(
    'data-papercraft-layout',
    variant === 'padded' ? 'padded' : 'centered',
  );

  view.localStorage.setItem('fixture', 'stored');
  app.setAttribute(
    'data-storage',
    view.localStorage.getItem('fixture') ?? 'missing',
  );

  const portaled: Element[] = [];

  if (variant === 'many') {
    app.innerHTML = '<span></span>'.repeat(500);
  } else {
    app.innerHTML = CARD;
  }

  if (variant === 'portal') {
    const overlay = document.createElement('div');
    overlay.id = 'overlay';
    overlay.setAttribute('data-papercraft-source', 'src/Overlay.tsx:7');
    overlay.textContent = 'open';
    document.body.append(overlay);
    portaled.push(overlay);
  }

  log.mounts.push(options.theme);

  return () => {
    log.unmounts += 1;
    app.remove();
    for (const element of portaled) element.remove();
    root.removeAttribute('data-papercraft-layout');
  };
}
