import { WidgetFocus } from '../../../src/client/components/molecules/widget-focus.js';
import { $isToolTurnNode } from '../../../src/client/components/organisms/conversation/nodes/tool-turn-node.js';
import { answer, promptIdOf, turnsOfLog } from '../../support/conversation.js';
import { $focusNodes, TurnsEditor } from '../../support/editor.js';

const prompt = promptIdOf(3601);

/**
 * A widget of the conversation, drawn in a `WidgetFocus`: a tool call, with
 * the answer after it.
 */
const widgets = turnsOfLog((log) => {
  log.prompt(prompt, 'Where is the Pay button drawn?');
  log.tool(
    prompt,
    'call-1',
    'grep',
    { pattern: 'Pay {formatTotal', path: 'src' },
    { output: 'src/components/Checkout.tsx:43' },
  );
  answer(log, prompt, 'In `src/components/Checkout.tsx`, line 43.');
}).filter((turn) => turn.type !== 'user');

export default {
  title: 'Chat/Molecules/Widget focus',
  component: WidgetFocus,
};

/** No widget holds the focus: a click on one takes it. */
export const Unfocused = {
  render: () => <TurnsEditor turns={widgets} />,
};

/** The tool call holds the editor's focus and wears its hover style. */
export const Focused = {
  render: () => (
    <TurnsEditor
      turns={widgets}
      after={(blocks) => $focusNodes(...blocks.filter($isToolTurnNode))}
    />
  ),
};
