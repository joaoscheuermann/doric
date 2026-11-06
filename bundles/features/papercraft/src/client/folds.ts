// The window's program folds (openui.md D4): one per Thread and the
// `papercraft` tag, made with lang-core's merge from papercraft's own adapter.
// A papercraft fence is never a question fence, so there is no `isQuestion`.

import { createProgramFolds } from 'openui/contracts';

import { mergeStatements } from './openui-adapter.js';

/** The fence tag papercraft draws (D6). */
export const PAPERCRAFT_TAG = 'papercraft';

export const programFolds = createProgramFolds(mergeStatements);
