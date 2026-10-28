import type { PromptJob } from 'runtime/contracts';

const envelopeTags = [
  'user-request',
  'parent-instruction',
  'terminal-output',
  'child-result',
  'bundle-instruction',
] as const;

const closingTags = new RegExp(`</(${envelopeTags.join('|')})`, 'gi');

const attribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');

/**
 * Wraps an input in the XML envelope that names where it came from:
 * `<user-request>`, `<parent-instruction thread="" prompt="">`,
 * `<terminal-output terminal="" prompt="">`, `<child-result thread=""
 * prompt="">` or `<bundle-instruction bundle="" reason="">`. Attribute values
 * escape `&`, `"` and `<`. In the body, a closing tag of any of these five
 * names becomes `<\/…`; nothing else changes. The result is
 * `<tag attrs>\n<body>\n</tag>`. Pure; never throws.
 */
export const input = (job: Pick<PromptJob, 'prompt' | 'source'>): string => {
  const source = job.source;
  const [tag, attributes] =
    source.kind === 'user'
      ? (['user-request', ''] as const)
      : source.kind === 'parent'
        ? ([
            'parent-instruction',
            ` thread="${attribute(source.threadId)}" prompt="${attribute(source.promptId)}"`,
          ] as const)
        : source.kind === 'terminal'
          ? ([
              'terminal-output',
              ` terminal="${attribute(source.terminalId)}" prompt="${attribute(source.promptId)}"`,
            ] as const)
          : source.kind === 'bundle'
            ? ([
                'bundle-instruction',
                ` bundle="${attribute(source.bundleId)}" reason="${attribute(source.reason)}"`,
              ] as const)
            : ([
                'child-result',
                ` thread="${attribute(source.threadId)}" prompt="${attribute(source.promptId)}"`,
              ] as const);
  const body = job.prompt.replace(closingTags, '<\\/$1');
  return `<${tag}${attributes}>
${body}
</${tag}>`;
};

/**
 * The default bundle's own instruction: `input({ prompt: body, source: {
 * kind: 'bundle', bundleId: 'default', reason } })`. reason is
 * `skills-changed` or `loaded-skills`. Pure; never throws.
 */
export const bundleInstruction = (reason: string, body: string): string =>
  input({
    prompt: body,
    source: { kind: 'bundle', bundleId: 'default', reason },
  });
