// The papercraft client's adapter over lang-core (concept R12, M12): with
// `frames/openui/runtime.ts`, the only module of papercraft's client that
// imports `@openuidev/*`. It gives the fence element lang-core's merge, for
// the fold (openui.md D4, D5), and the parser the app's check walks (D6, D16).

import { mergeStatements as merge } from '@openuidev/lang-core';

export {
  type ASTNode,
  parseExpression,
  split,
  tokenize,
  walkAST,
} from '@openuidev/lang-core';

/** lang-core's `mergeStatements`, which the fold calls for each patch. */
export const mergeStatements = (existing: string, patch: string): string =>
  merge(existing, patch);
