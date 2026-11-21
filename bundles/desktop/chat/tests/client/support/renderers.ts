// A probe bundle of made-up registrants for `chat.views/v1` 1.2.0 (bundle
// isolation 5(a), T5.1–T5.4): it defines its elements through `ui/v1`,
// registers tool and input renderers once `chat.views/v1` is available, and
// writes down what the chat does with each element: created, every `view` it
// was given, connected, toggled, disposed. Every element holds a `<button>`,
// standing for a control inside the drawing.
//
// The elements:
// - `probe-tool-call` and `probe-input` draw a view and nothing more;
// - `probe-toggle-call` and `probe-toggle-input` also define `toggle()`, and
//   show their block open while the reader has not chosen, so their answer to
//   the toggle key differs from the chat's generic one.

import {
  type ClientContext,
  type Disposable,
  isContractError,
  UiV1,
} from 'bundle/contracts';
import { defineExtension, type LexicalEditor } from 'lexical';

import {
  CHAT_BLOCK_CHOSEN_EVENT,
  type ChatBlockChosenDetail,
  type ChatInputView,
  ChatLexicalV1,
  type ChatToolView,
  type ChatViews,
  ChatViewsV1,
  type InputRendererSpec,
  type ToolRendererSpec,
} from '../../../src/contracts/index.js';
import type { Probe } from './window.js';

export const TOOL_ELEMENT = 'probe-tool-call';
export const TOGGLE_TOOL_ELEMENT = 'probe-toggle-call';
export const INPUT_ELEMENT = 'probe-input';
export const TOGGLE_INPUT_ELEMENT = 'probe-toggle-input';
/** The probe's `chat.delegated-input/v1` block renderer, when it registers one. */
export const DELEGATED_ELEMENT = 'probe-delegated';

/** One element of the probe, as the chat left it. */
export interface ProbeElement extends HTMLElement {
  /** The `view` the chat set last. */
  view?: ChatToolView | ChatInputView;
  /** Every `view` the chat set, in order. */
  readonly views: readonly (ChatToolView | ChatInputView)[];
}

export interface RendererProbeState {
  readonly created: ProbeElement[];
  /** Each `connectedCallback`, with the `view` the element held then. */
  readonly connected: { element: ProbeElement; view: unknown }[];
  /** Each element `ui/v1.dispose` reached. */
  readonly disposed: ProbeElement[];
  /** Each element whose `toggle()` the chat called. */
  readonly toggled: ProbeElement[];
  /** The tool registrations the probe holds, by tool name. */
  readonly tools: Map<string, Disposable>;
  /** The input registrations the probe holds, by source. */
  readonly inputs: Map<string, Disposable>;
  /** What a definition or a registration threw, in order. */
  readonly errors: unknown[];
  views?: ChatViews;
  editor?: LexicalEditor;
  /** Registers a tool renderer as the probe, writing down what it threw. */
  registerTool(spec: ToolRendererSpec): void;
  /** Registers an input renderer as the probe, writing down what it threw. */
  registerInput(spec: InputRendererSpec): void;
}

/** Dispatches the reader's choice from inside `element`, as a drawing does. */
export const choose = (element: Element, chosen: boolean): CustomEvent => {
  const from = element.querySelector('button') ?? element;
  const event = new CustomEvent<ChatBlockChosenDetail>(
    CHAT_BLOCK_CHOSEN_EVENT,
    { detail: { chosen }, bubbles: true, composed: true },
  );
  from.dispatchEvent(event);
  return event;
};

/** The probe's elements of `tag` in the window's document, in document order. */
export const probeElements = (document: Document, tag: string) =>
  [...document.querySelectorAll(tag)] as unknown as ProbeElement[];

/**
 * The probe: `tools` and `inputs` are registered once `chat.views/v1` is
 * available, in order, each failure written down in `errors`.
 */
export const rendererProbe = (
  input: {
    readonly tools?: readonly ToolRendererSpec[];
    readonly inputs?: readonly InputRendererSpec[];
    /** Also draws `chat.delegated-input/v1` blocks with `probe-delegated`. */
    readonly delegated?: boolean;
  } = {},
): { probe: Probe; state: RendererProbeState } => {
  const state: RendererProbeState = {
    created: [],
    connected: [],
    disposed: [],
    toggled: [],
    tools: new Map(),
    inputs: new Map(),
    errors: [],
    registerTool(spec) {
      try {
        const views = state.views;
        if (views === undefined) throw new Error('the probe is not active');
        const registration = views.registerToolRenderer(spec);
        state.tools.set(spec.toolName, registration);
      } catch (error) {
        state.errors.push(error);
      }
    },
    registerInput(spec) {
      try {
        const views = state.views;
        if (views === undefined) throw new Error('the probe is not active');
        const registration = views.registerInputRenderer(spec);
        state.inputs.set(spec.source, registration);
      } catch (error) {
        state.errors.push(error);
      }
    },
  };

  const probe: Probe = {
    requires: [
      'chat.views/v1@^1.2.0',
      'ui/v1@^1.0.0',
      'chat.lexical/v1@^1.0.0',
    ],
    activate: ({ services }: ClientContext) => {
      const ui = services.use(UiV1);
      const Base = globalThis.HTMLElement;

      class Drawing extends Base {
        #view: ChatToolView | ChatInputView | undefined;
        readonly views: (ChatToolView | ChatInputView)[] = [];
        constructor() {
          super();
          state.created.push(this as unknown as ProbeElement);
        }
        get view() {
          return this.#view;
        }
        set view(value: ChatToolView | ChatInputView | undefined) {
          this.#view = value;
          if (value !== undefined) this.views.push(value);
        }
        connectedCallback() {
          state.connected.push({
            element: this as unknown as ProbeElement,
            view: this.#view,
          });
          if (this.querySelector('button') === null)
            this.append(this.ownerDocument.createElement('button'));
        }
        dispose() {
          state.disposed.push(this as unknown as ProbeElement);
        }
      }

      /** Shows its block open until the reader chooses; Enter folds it first. */
      class ToggleDrawing extends Drawing {
        toggle() {
          state.toggled.push(this as unknown as ProbeElement);
          const shown = this.view?.chosen ?? true;
          choose(this, !shown);
        }
      }

      for (const [tag, element] of [
        [TOOL_ELEMENT, Drawing],
        [INPUT_ELEMENT, Drawing],
        [TOGGLE_TOOL_ELEMENT, ToggleDrawing],
        [TOGGLE_INPUT_ELEMENT, ToggleDrawing],
        [DELEGATED_ELEMENT, Drawing],
      ] as const) {
        try {
          ui.define(tag, class extends element {});
        } catch (error) {
          state.errors.push(error);
        }
      }

      services.use(ChatLexicalV1).registerExtension(
        defineExtension({
          name: 'test/renderer-editor',
          register: (editor) => {
            // StrictMode builds the editor twice; the first one is kept.
            state.editor ??= editor;
            return () => {};
          },
        }),
      );

      services.whenAvailable(ChatViewsV1, (views) => {
        state.views = views;
        if (input.delegated === true) {
          try {
            views.registerRenderer({
              blockType: 'chat.delegated-input/v1',
              elementTag: DELEGATED_ELEMENT,
            });
          } catch (error) {
            state.errors.push(error);
          }
        }
        for (const spec of input.tools ?? []) state.registerTool(spec);
        for (const spec of input.inputs ?? []) state.registerInput(spec);
      });
    },
  };
  return { probe, state };
};

/** The probe activated, and every definition and registration it made held. */
export const assertReady = (state: RendererProbeState): void => {
  if (state.views === undefined)
    throw new Error(
      'the probe did not activate: chat.views/v1@^1.2.0 is not available',
    );
  if (state.errors.length > 0)
    throw new Error(
      `the probe's registrations failed: ${state.errors.map(String).join('; ')}`,
    );
};

/** The codes of what the probe's registrations threw, in order. */
export const errorCodes = (state: RendererProbeState): readonly string[] =>
  state.errors.map((error) =>
    isContractError(error) ? error.code : String(error),
  );
