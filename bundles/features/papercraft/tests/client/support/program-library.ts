// A repository library module as the program frame imports it (D10–D13,
// D15): `components` (react-lang definitions), `papercraftAbi` and, with
// `?harness=1`, a `Harness` that wraps the whole program once. It stands in
// for what the library job builds from a repository's `schemas/` folder and
// `.storybook/preview.tsx`; the frame reads it only through those exports.
//
// The URL's query picks the variant:
// - `abi=ok` (default): `papercraftAbi` is the frame's shim ABI
//   (`src/sandbox/shim-names.ts`'s `SHIM_ABI`); `abi=stale` names another;
// - `harness=1`: exports `Harness`, which provides a context every component
//   of this library reads, and counts its renders;
// - `run=<n>`: a fresh module instance per test, so counts never mix.
//
// Tests reach it by URL only (`./program-library.js?…`): importing it
// statically would tie the test file's loading to `shim-names.ts`.

import { defineComponent } from '@openuidev/react-lang';
import {
  createContext,
  createElement,
  Fragment,
  type ReactNode,
  useContext,
} from 'react';
import { z } from 'zod';

const params = new URL(import.meta.url).searchParams;

/** The shim ABI the frame checks a library against, as the runner writes it. */
const frameAbi = async (): Promise<string> => {
  const names = (await import(
    new URL('../../../src/sandbox/shim-names.js', import.meta.url).href
  )) as { readonly SHIM_ABI: string };

  return names.SHIM_ABI;
};

export const papercraftAbi =
  params.get('abi') === 'stale' ? 'not-the-frame-abi' : await frameAbi();

/** What the harness provides; a component outside it reads `none`. */
const HarnessValue = createContext('none');

/** How many times `Harness` rendered, for this module instance. */
export const harnessRenders = { count: 0 };

/** `Greeting(name)`: a paragraph that says which harness value it read. */
const Greeting = defineComponent({
  name: 'Greeting',
  props: z.object({ name: z.string() }),
  description: 'Greets someone.',
  component: ({ props }) =>
    createElement(
      'p',
      { className: 'greeting', 'data-context': useContext(HarnessValue) },
      `Hello, ${props.name}`,
    ),
});

/** `Pair(left, right)`: two sibling boxes with no element around them. */
const Pair = defineComponent({
  name: 'Pair',
  props: z.object({ left: z.string(), right: z.string() }),
  description: 'Two boxes side by side.',
  component: ({ props }) =>
    createElement(
      Fragment,
      null,
      createElement('span', { className: 'pair-left' }, props.left),
      createElement('span', { className: 'pair-right' }, props.right),
    ),
});

export const components = [Greeting, Pair];

function HarnessComponent({
  children,
}: {
  readonly theme: 'light' | 'dark';
  readonly children?: ReactNode;
}): ReactNode {
  harnessRenders.count += 1;

  return createElement(
    HarnessValue.Provider,
    { value: 'from-harness' },
    children,
  );
}

export const Harness =
  params.get('harness') === '1' ? HarnessComponent : undefined;
