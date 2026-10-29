// The measure frame's entry: `doric://app/frame/boot.js` imports this module
// (built to `client/frames/diagram.js`) inside the measure frame's sandboxed
// iframe, and it starts the runtime on the frame's own window.

import {
  type DiagramFrameWindow,
  startDiagramFrame,
} from './diagram/runtime.js';

startDiagramFrame(window as DiagramFrameWindow);
