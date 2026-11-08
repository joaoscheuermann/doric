// The program frame's entry (D6): `doric://app/frame/boot.js` imports this
// module (built to `client/frames/openui.js`) inside a papercraft fence's
// sandboxed iframe, and it starts the protocol-2 runtime on the frame's
// window with its three sheets.

import { type FrameWindow, startProgramFrame } from './openui/runtime.js';
import { sheets } from './openui/sheets.js';

startProgramFrame(window as FrameWindow, sheets);
