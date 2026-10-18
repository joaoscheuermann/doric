// A plain-JS installed bundle for the generation tests. Its one tool reports
// the generation and process it runs in. Given a `gate` path it first writes
// `<gate>.started` and then waits for `<gate>.release` to exist, so a test can
// hold a prompt inside a tool call while it switches or kills the generation.
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { DoricBundleV1, ToolsV1 } from 'bundle/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

const released = async (path) => {
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      await delay(20);
    }
  }
};

const probe = defineTool({
  name: 'probe',
  description: 'Reports the generation and process this tool runs in.',
  input: z.object({ gate: z.string().optional() }).strict(),
  output: z.object({ generation: z.number(), pid: z.number() }).strict(),
  execute: async (input, call, services) => {
    if (input.gate !== undefined) {
      await writeFile(`${input.gate}.started`, String(process.pid));
      await released(`${input.gate}.release`);
    }
    const { generation } = services.use(DoricBundleV1).describe(call);
    return { generation, pid: process.pid };
  },
});

export const activate = ({ services }) => {
  services.use(ToolsV1).register(probe, { alwaysAvailable: true });
};
