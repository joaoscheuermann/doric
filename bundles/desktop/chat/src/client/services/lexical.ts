// `chat.lexical/v1` (§7.2, §7.4): Lexical nodes and extensions other bundles
// add to the conversation editor. The list freezes when the window's first
// conversation editor is created (the surface calls `freeze()` then); later
// registrations fail with `frozen`, and a removal after the freeze leaves the
// frozen list as it was, since a live editor cannot drop a node class.

import {
  ContractError,
  type Disposable,
  defineMethod,
  defineService,
} from 'bundle/contracts';
import type { AnyLexicalExtension, Klass, LexicalNode } from 'lexical';
import { z } from 'zod';

import { ChatLexicalV1 } from '../../contracts/index.js';

type NodeClass = Klass<LexicalNode>;

const nodeListSchema = z.custom<readonly NodeClass[]>(
  (value) =>
    Array.isArray(value) && value.every((node) => typeof node === 'function'),
  { message: 'Expected an array of Lexical node classes.' },
);

const extensionSchema = z.custom<AnyLexicalExtension>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string',
  { message: 'Expected a Lexical extension.' },
);

const disposable = z.custom<Disposable>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { dispose?: unknown }).dispose === 'function',
  { message: 'Expected a Disposable.' },
);

export interface ChatLexicalRegistry {
  /** Freezes the lists and returns them; idempotent. */
  freeze(): {
    readonly nodes: readonly NodeClass[];
    readonly extensions: readonly AnyLexicalExtension[];
  };
  readonly frozen: () => boolean;
}

const frozenError = (): ContractError =>
  new ContractError(
    'frozen',
    'The conversation editor already exists; Lexical registrations are closed for this window.',
  );

export const createChatLexical = () => {
  const nodes: { readonly list: readonly NodeClass[] }[] = [];
  const extensions: { readonly extension: AnyLexicalExtension }[] = [];
  let frozen:
    | {
        readonly nodes: readonly NodeClass[];
        readonly extensions: readonly AnyLexicalExtension[];
      }
    | undefined;

  const removal = <T>(list: T[], entry: T): Disposable => {
    let done = false;
    return {
      dispose: () => {
        if (done) return;
        done = true;
        if (frozen !== undefined) return;
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
      },
    };
  };

  const registry: ChatLexicalRegistry = {
    freeze: () => {
      frozen ??= {
        nodes: Object.freeze(nodes.flatMap(({ list }) => list)),
        extensions: Object.freeze(extensions.map(({ extension }) => extension)),
      };
      return frozen;
    },
    frozen: () => frozen !== undefined,
  };

  const service = defineService(ChatLexicalV1, {
    registerNodes: defineMethod({
      input: nodeListSchema,
      output: disposable,
      execute: (list: readonly NodeClass[]) => {
        if (frozen !== undefined) throw frozenError();
        const entry = { list: Object.freeze([...list]) };
        nodes.push(entry);
        return removal(nodes, entry);
      },
    }),
    registerExtension: defineMethod({
      input: extensionSchema,
      output: disposable,
      execute: (extension: AnyLexicalExtension) => {
        if (frozen !== undefined) throw frozenError();
        const entry = { extension };
        extensions.push(entry);
        return removal(extensions, entry);
      },
    }),
  });

  return { service, registry };
};

let current: ChatLexicalRegistry | undefined;

/** The window's registry while the chat part is active. */
export const chatLexicalRegistry = (): ChatLexicalRegistry | undefined =>
  current;

export const setChatLexicalRegistry = (
  registry: ChatLexicalRegistry | undefined,
): void => {
  current = registry;
};
