import { posix as path } from 'node:path';

import { ATTACHMENT_MAX_BYTES, attachmentReference } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import type { FilesToolPorts } from '../ports.js';

const description = `Look at an image file in the workspace: a PNG, JPEG, WebP or GIF of at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB. The image itself comes back with the result, so you see it, and the result's line shows it to the reader in the conversation. A relative path resolves against the current working directory.`;

export const input = z.object({ path: z.string().min(1) }).strict();

/** The reference line that names the image, as the conversation stores it. */
export const output = z.string();

/** Creates the tool that hands the model an image from the sandbox. */
export const tool = defineTool({
  name: 'view-image',
  description,
  input,
  output,
  // The result is an attachment's reference line, which reaches the model as
  // the image itself.
  resultModalities: ['image'],
  execute: async (input, call, ports: FilesToolPorts): Promise<string> => {
    const cwd = await ports.cwd(call);
    const filePath = path.normalize(
      path.isAbsolute(input.path) ? input.path : path.join(cwd, input.path),
    );
    // The Project keeps the image; a file that is not one is refused there,
    // and that refusal is what the model reads.
    const attached = await ports.attachFile(filePath, call);

    return attachmentReference(attached.name, attached.id);
  },
});
