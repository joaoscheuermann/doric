// The program frame's three sheets (D6, D31), as text for `<style>` elements,
// in their order: Doric's tokens, react-ui's layered sheet, Doric's
// `--openui-*` tokens. Only the entry imports this module, so the runtime
// (and the tests that load it) never import a `.css` file.

import reactUiSheet from '@openuidev/react-ui/layered/styles/index.css' with {
  type: 'text',
};

import doricTokens from '../../../../../../../packages/desktop/src/styles/tokens.css' with {
  type: 'text',
};
import openuiTokens from '../../../../../openui/src/client/tokens.css' with {
  type: 'text',
};

export const sheets: readonly string[] = [
  doricTokens,
  reactUiSheet,
  openuiTokens,
];
