/**
 * A module written the way a bundle's client part is: it imports the platform
 * packages by their import-map specifiers only, then reports what it saw.
 */
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContractError } from 'bundle/contracts';
import { Button } from 'desktop/ui/button';
import { $getRoot, createEditor } from 'lexical';
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';

const Counter = () => {
  const [count] = useState(3);
  return createElement(Button, { variant: 'secondary' }, `Count ${count}`);
};

const EditorProbe = () => {
  const [editor] = useLexicalComposerContext();
  return createElement('span', null, typeof editor.update);
};

const editor = createEditor();
let rootType;
editor.update(
  () => {
    rootType = $getRoot().getType();
  },
  { discrete: true },
);

const report = {
  button: renderToStaticMarkup(createElement(Counter)),
  composer: renderToStaticMarkup(
    createElement(
      LexicalComposer,
      {
        initialConfig: {
          namespace: 'probe',
          onError: (error) => {
            throw error;
          },
        },
      },
      createElement(EditorProbe),
    ),
  ),
  rootType,
  zod: z.object({ id: z.string() }).safeParse({ id: 'x' }).success,
  contractError: typeof ContractError,
  createRoot: typeof createRoot,
};

process.stdout.write(JSON.stringify(report));
