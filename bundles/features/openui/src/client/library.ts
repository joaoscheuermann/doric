// The conversation library (openui.md D7, D17; conversation-openui.md D21,
// D29), in the renderer chunk: react-ui's library with the three question
// built-ins added and `Modal` drawn inside the fence (U28).

import {
  type ComponentRenderProps,
  createParser,
  defineComponent,
  type ParseResult,
  useStateField,
} from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import { createElement, type ReactNode } from 'react';

import { defineQuestionBuiltins } from '../contracts/index.js';
import { AskFormView } from './question/ask-form.js';

const none = () => null;

/** AskOption and AskQuestion draw nothing themselves: `AskForm` reads the whole question from the program (D21). */
const [AskOption, AskQuestion, AskForm] = defineQuestionBuiltins(
  defineComponent,
  { AskOption: none, AskQuestion: none, AskForm: AskFormView },
);

const modal = openuiLibrary.components.Modal;

/** `Modal`'s title and children in a bordered block inside the fence while its open state is true. */
function InlineModal({
  props,
  renderNode,
}: ComponentRenderProps<{
  readonly title?: string;
  readonly open?: unknown;
  readonly children?: unknown;
}>): ReactNode {
  const field = useStateField('open', props.open);
  if (field.value !== true && field.value !== 'true') return null;
  return createElement(
    'section',
    {
      className: 'openui-inline-modal rounded-lg border border-border p-3',
      'aria-label': props.title,
    },
    createElement('h3', { className: 'mb-2 font-medium' }, props.title),
    renderNode(props.children),
  );
}

/** react-ui's `Modal` with its schema and description, drawn inline. */
const Modal = defineComponent({
  name: 'Modal',
  props: modal.props,
  description: modal.description,
  component: InlineModal,
});

/** The conversation library: react-ui's, the question built-ins, and `Modal` inline. */
export const library = openuiLibrary.extend({
  components: { add: [AskForm, AskQuestion, AskOption], override: [Modal] },
});

let parser: ReturnType<typeof createParser> | undefined;

/** `createParser(library.toJSONSchema(), library.root).parse(program)`, with the parser made once. */
export const parseProgram = (program: string): ParseResult => {
  parser ??= createParser(library.toJSONSchema(), library.root);
  return parser.parse(program);
};
