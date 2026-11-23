import type { ToolInput, ToolOutput, UnboundTool } from 'tool';

import type { FilesToolPorts } from '../ports.js';
import { tool as cwd } from './cwd.js';
import { tool as edit } from './edit.js';
import { tool as find } from './find.js';
import { tool as grep } from './grep.js';
import { tool as tree } from './tree.js';
import { tool as viewImage } from './view-image.js';
import { tool as write } from './write.js';

/** One workspace tool and its global model-visible position (D10-5). */
export interface FileToolEntry {
  readonly tool: UnboundTool<ToolInput, ToolOutput, FilesToolPorts>;
  readonly order: number;
}

/**
 * The seven tools in registration order: cwd 100, edit 200, find 300,
 * grep 400, tree 600, write 800, view-image 850. Both entries (kernel
 * `activate` and the host part) register exactly these, with
 * `alwaysAvailable: true`. `terminal` (500) is the `terminal` bundle's, and
 * `web` (700) the `web` bundle's.
 */
export const fileTools: readonly FileToolEntry[] = [
  { tool: cwd, order: 100 },
  { tool: edit, order: 200 },
  { tool: find, order: 300 },
  { tool: grep, order: 400 },
  { tool: tree, order: 600 },
  { tool: write, order: 800 },
  { tool: viewImage, order: 850 },
];
