import {
  DIAGRAM_BLOCK_TYPE,
  DIAGRAM_BODY_TAG,
  DIAGRAM_KIND,
} from '../contracts/index.js';

/**
 * The `diagram` kind's declaration for `artifact.kind/v1.register`: no
 * `payload` and no `materialize` — the tool and the service hand the registry
 * ready entries and bytes. The body (`<drawio-diagram>`) draws its own header.
 */
export const diagramKind = {
  id: DIAGRAM_KIND,
  title: 'Diagrama',
  blockType: DIAGRAM_BLOCK_TYPE,
  bodyTag: DIAGRAM_BODY_TAG,
  header: 'body',
} as const;
