// `chat.views/v1` (§7.7): projectors of other bundles' event types and the
// elements that draw their block types. The built-in projection owns every
// type `builtInClaims` names, so a projector claiming one of them conflicts
// with it. The surface reads the registry through `projectors()`,
// `rendererFor()` and `subscribe()`.

import {
  type Call,
  ContractError,
  type Disposable,
  defineMethod,
  defineService,
} from 'bundle/contracts';
import { legacyEventTypes } from 'runtime/contracts';
import { z } from 'zod';

import {
  ChatViewsV1,
  type ProjectorSpec,
  type RendererSpec,
  rendererSpecSchema,
} from '../../contracts/index.js';
import { builtInClaims } from '../domain/external-blocks.js';

/** The qualified aliases of the durable runtime event types. */
export const builtInAliases: readonly string[] = Object.freeze(
  Object.values(legacyEventTypes),
);

/** The owner the built-in projection reports in a conflict. */
const BUILT_IN_OWNER = 'chat';

/** The element that draws a block no renderer claims. */
export const GENERIC_BLOCK_TAG = 'chat-block';

const isProjectorSpec = (value: unknown): value is ProjectorSpec => {
  if (typeof value !== 'object' || value === null) return false;
  const spec = value as Record<string, unknown>;
  return (
    Array.isArray(spec.eventTypes) &&
    spec.eventTypes.every(
      (type) => typeof type === 'string' && type.length > 0,
    ) &&
    typeof spec.initial === 'function' &&
    typeof spec.reduce === 'function'
  );
};

const projectorSpecSchema = z.custom<ProjectorSpec>(isProjectorSpec, {
  message: 'Expected { eventTypes, initial, reduce }.',
});

const disposable = z.custom<Disposable>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { dispose?: unknown }).dispose === 'function',
  { message: 'Expected a Disposable.' },
);

const once = (dispose: () => void): Disposable => {
  let done = false;
  return {
    dispose: () => {
      if (done) return;
      done = true;
      dispose();
    },
  };
};

interface Registered<T> {
  readonly spec: T;
  readonly owner: string;
}

export interface ChatViewsRegistry {
  /** The registered projectors, in registration order. */
  projectors(): readonly ProjectorSpec[];
  /** The tag that draws a block type: its renderer's, else `chat-block`. */
  rendererFor(blockType: string): string;
  /** Called after every registration or its removal. */
  subscribe(listener: () => void): () => void;
}

export interface ChatViewsOptions {
  /** Whether a custom element tag is defined (in the window: `customElements`). */
  readonly isDefined?: (tag: string) => boolean;
}

const definedInWindow = (tag: string): boolean =>
  (
    globalThis as { customElements?: { get(name: string): unknown } }
  ).customElements?.get(tag) !== undefined;

export const createChatViews = (options: ChatViewsOptions = {}) => {
  const isDefined = options.isDefined ?? definedInWindow;
  const projectors: Registered<ProjectorSpec>[] = [];
  const claims = new Map<string, Registered<ProjectorSpec>>();
  const renderers = new Map<string, Registered<RendererSpec>>();
  const listeners = new Set<() => void>();
  let snapshot: readonly ProjectorSpec[] = Object.freeze([]);

  const changed = (): void => {
    snapshot = Object.freeze(projectors.map(({ spec }) => spec));
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('Doric: a chat views listener failed:', error);
      }
    }
  };

  const registry: ChatViewsRegistry = {
    projectors: () => snapshot,
    rendererFor: (blockType) =>
      renderers.get(blockType)?.spec.elementTag ?? GENERIC_BLOCK_TAG,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const service = defineService(ChatViewsV1, {
    registerProjector: defineMethod({
      input: projectorSpecSchema,
      output: disposable,
      execute: (spec: ProjectorSpec, call: Call) => {
        const owner = call.caller.bundleId;
        const types = [...new Set(spec.eventTypes)];
        for (const type of types) {
          const holder = builtInClaims(type, builtInAliases)
            ? BUILT_IN_OWNER
            : claims.get(type)?.owner;
          if (holder !== undefined) {
            throw new ContractError(
              'registration_conflict',
              `The event type "${type}" is already projected by "${holder}".`,
              { eventType: type, owner: holder },
            );
          }
        }
        const registered: Registered<ProjectorSpec> = {
          spec: { ...spec, eventTypes: Object.freeze(types) },
          owner,
        };
        projectors.push(registered);
        for (const type of types) claims.set(type, registered);
        changed();
        return once(() => {
          const index = projectors.indexOf(registered);
          if (index >= 0) projectors.splice(index, 1);
          for (const type of types) {
            if (claims.get(type) === registered) claims.delete(type);
          }
          changed();
        });
      },
    }),
    registerRenderer: defineMethod({
      input: rendererSpecSchema,
      output: disposable,
      execute: (spec: RendererSpec, call: Call) => {
        const holder = renderers.get(spec.blockType);
        if (holder !== undefined) {
          throw new ContractError(
            'registration_conflict',
            `The block type "${spec.blockType}" is already drawn by "${holder.owner}".`,
            { blockType: spec.blockType, owner: holder.owner },
          );
        }
        if (!isDefined(spec.elementTag)) {
          throw new ContractError(
            'invalid_input',
            `The element <${spec.elementTag}> is not defined.`,
            { elementTag: spec.elementTag },
          );
        }
        const registered: Registered<RendererSpec> = {
          spec: { blockType: spec.blockType, elementTag: spec.elementTag },
          owner: call.caller.bundleId,
        };
        renderers.set(spec.blockType, registered);
        changed();
        return once(() => {
          if (renderers.get(spec.blockType) === registered)
            renderers.delete(spec.blockType);
          changed();
        });
      },
    }),
  });

  return { service, registry };
};

let current: ChatViewsRegistry | undefined;

/** The window's registry while the chat part is active. */
export const chatViewsRegistry = (): ChatViewsRegistry | undefined => current;

export const setChatViewsRegistry = (
  registry: ChatViewsRegistry | undefined,
): void => {
  current = registry;
};
