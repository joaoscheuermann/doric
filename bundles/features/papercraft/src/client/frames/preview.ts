// The preview frame's entry: `doric://app/frame/boot.js` imports this module
// (built to `client/frames/preview.js`) inside a preview's sandboxed iframe,
// and it starts the runtime on the frame's own window.

import { type FrameWindow, startPreviewFrame } from './preview/runtime.js';

startPreviewFrame(window as FrameWindow);
