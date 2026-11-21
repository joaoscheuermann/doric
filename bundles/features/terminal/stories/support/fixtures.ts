// The terminals the stories show under the Thread "Split the payment form
// into steps": the agent's dev server and test run, and a shell the user
// opened, each with the output a real session prints (ANSI colours included).

import type { Terminal } from '../../src/client/domain/terminals.js';

const projectId = 'prj_checkout';
export const threadId = 'thr_payment_form';

/** An ISO time `seconds` before the story loaded. */
const secondsAgo = (seconds: number): string =>
  new Date(Date.now() - seconds * 1000).toISOString();

export const devServer: Terminal = {
  id: 'term_dev_server',
  projectId,
  threadId,
  origin: 'agent',
  command: 'npm run dev --workspace apps/web',
  cwd: '/workspace',
  startedAt: secondsAgo(83),
  timeoutMs: null,
  state: 'running',
  pty: false,
};

export const testRun: Terminal = {
  id: 'term_vitest',
  projectId,
  threadId,
  origin: 'agent',
  command: 'npx vitest run apps/web/src/checkout',
  cwd: '/workspace',
  startedAt: secondsAgo(41),
  timeoutMs: 120_000,
  state: 'exited',
  pty: false,
};

export const userShell: Terminal = {
  id: 'term_user_shell',
  projectId,
  threadId,
  origin: 'user',
  command: 'bash',
  cwd: '/workspace',
  startedAt: secondsAgo(600),
  timeoutMs: null,
  state: 'running',
  pty: true,
};

export const startingBuild: Terminal = {
  id: 'term_build',
  projectId,
  threadId,
  origin: 'agent',
  command:
    'npm run build --workspace apps/web -- --mode production --sourcemap --emptyOutDir',
  cwd: '/workspace',
  startedAt: secondsAgo(2),
  timeoutMs: 300_500,
  state: 'starting',
  pty: false,
};

export const terminals: readonly Terminal[] = [devServer, testRun, userShell];

const esc = '\u001b[';
const green = `${esc}32m`;
const red = `${esc}31m`;
const cyan = `${esc}36m`;
const dim = `${esc}2m`;
const bold = `${esc}1m`;
const reset = `${esc}0m`;

export const devServerOutput = [
  '',
  `> checkout-web@0.4.0 dev`,
  `> vite --host 0.0.0.0`,
  '',
  `  ${bold}${green}VITE${reset} ${green}v7.1.4${reset}  ${dim}ready in${reset} ${bold}412${reset} ms`,
  '',
  `  ${green}➜${reset}  ${bold}Local${reset}:   ${cyan}http://localhost:${bold}5173${reset}${cyan}/${reset}`,
  `  ${green}➜${reset}  ${bold}Network${reset}: ${cyan}http://172.18.0.4:${bold}5173${reset}${cyan}/${reset}`,
  `  ${dim}➜  press h + enter to show help${reset}`,
  `${dim}8:02:14 AM${reset} ${cyan}${bold}[vite]${reset} ${green}hmr update${reset} ${dim}/src/checkout/payment-form.tsx${reset}`,
  `${dim}8:02:31 AM${reset} ${cyan}${bold}[vite]${reset} ${green}hmr update${reset} ${dim}/src/checkout/shipping-step.tsx${reset}`,
  '',
].join('\n');

export const testOutput = [
  '',
  ` ${bold}${cyan}RUN${reset} ${cyan}v3.2.4${reset} ${dim}/workspace${reset}`,
  '',
  ` ${green}✓${reset} apps/web/src/checkout/use-cart.test.ts ${dim}(6 tests)${reset} ${dim}18ms${reset}`,
  ` ${green}✓${reset} apps/web/src/checkout/shipping-step.test.tsx ${dim}(4 tests)${reset} ${dim}112ms${reset}`,
  ` ${red}❯${reset} apps/web/src/checkout/payment-form.test.tsx ${dim}(5 tests | ${reset}${red}1 failed${reset}${dim})${reset} ${dim}164ms${reset}`,
  `   ${red}×${reset} disables the pay button while submitting ${dim}41ms${reset}`,
  '',
  `${red}${bold} FAIL ${reset} apps/web/src/checkout/payment-form.test.tsx > disables the pay button while submitting`,
  `${red}AssertionError: expected <button> to be disabled${reset}`,
  ` ${cyan}❯${reset} apps/web/src/checkout/payment-form.test.tsx:${bold}48${reset}:${bold}36${reset}`,
  '',
  ` ${dim}Test Files${reset}  ${red}${bold}1 failed${reset} ${dim}|${reset} ${green}${bold}2 passed${reset} ${dim}(3)${reset}`,
  ` ${dim}     Tests${reset}  ${red}${bold}1 failed${reset} ${dim}|${reset} ${green}${bold}14 passed${reset} ${dim}(15)${reset}`,
  ` ${dim}  Duration${reset}  1.24s`,
  '',
].join('\n');

export const shellOutput = [
  `${green}${bold}doric@sandbox${reset}:${cyan}${bold}/workspace${reset}$ git status --short\r`,
  ` ${red}M${reset} apps/web/src/checkout/payment-form.tsx\r`,
  ` ${red}D${reset} apps/web/src/checkout/use-cart.ts\r`,
  `${red}??${reset} apps/web/src/checkout/shipping-step.tsx\r`,
  `${green}${bold}doric@sandbox${reset}:${cyan}${bold}/workspace${reset}$ `,
].join('\n');

/** Many lines, to show the scrollback and its scrollbar. */
export const longOutput = Array.from(
  { length: 240 },
  (_, index) =>
    `${dim}[build]${reset} transformed ${cyan}src/chunk-${String(index).padStart(3, '0')}.js${reset} ${dim}(${(index * 0.37 + 1.2).toFixed(2)} kB)${reset}`,
).join('\n');

/** The output each fixture terminal's watch sends as its snapshot. */
export const outputs: Readonly<Record<string, string>> = {
  [devServer.id]: devServerOutput,
  [testRun.id]: testOutput,
  [userShell.id]: shellOutput,
  [startingBuild.id]: longOutput,
};

// The chat drawings --------------------------------------------------------
// The fixtures of the `terminal` call and background result stories, moved
// with them from the chat's `stories/support/fixtures.ts` (bundle isolation
// 5(b), change 4).

/** A terminal command's compact result, as `terminal.compact.v1` writes it. */
export const terminalResult = (input: {
  readonly command: string;
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly tail?: readonly string[];
  readonly omitted?: number;
  readonly exitCode?: number;
  readonly durationMs?: number;
}): string => {
  const stream = (
    head: readonly string[],
    tail: readonly string[] = [],
    omitted = 0,
  ) => ({
    bytes: [...head, ...tail].join('\n').length,
    lines: head.length + tail.length + omitted,
    head,
    tail,
    omitted_lines: omitted,
    omitted_bytes: omitted * 48,
    truncated: omitted > 0,
  });
  const exitCode = input.exitCode ?? 0;
  return JSON.stringify({
    schema: 'terminal.compact.v1',
    command: input.command,
    working_directory: '/workspace/storefront',
    exit_code: exitCode,
    duration_ms: input.durationMs ?? 2_340,
    termination_reason: 'exited',
    success: exitCode === 0,
    stdout: stream(input.stdout ?? [], input.tail, input.omitted),
    stderr: stream(input.stderr ?? []),
  });
};

export const testCommand = 'npm test -- --run src/checkout';

/**
 * The prompt a settled background command writes into its Thread, as
 * `terminal/v1` frames it: the header, the outcome, and the last of each
 * stream the host kept.
 */
export const backgroundResult = (input: {
  readonly terminalId: string;
  /** The prompt that started the command. */
  readonly promptId: string;
  readonly command: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly reason?: 'exited' | 'timeout' | 'terminated' | 'failed';
  readonly durationMs?: number;
}): string =>
  [
    '# Background terminal result',
    '',
    `Terminal: ${input.terminalId}`,
    `Originating prompt: ${input.promptId}`,
    `Command: ${input.command}`,
    `Exit code: ${input.exitCode ?? 0}`,
    `Reason: ${input.reason ?? 'exited'}`,
    `Duration: ${input.durationMs ?? 2_340} ms`,
    '',
    '## Standard output (last 12000 characters)',
    '',
    input.stdout ?? '',
    '',
    '## Standard error (last 12000 characters)',
    '',
    input.stderr ?? '',
  ].join('\n');

export const terminalArgs = (command: string, background = false): string =>
  JSON.stringify({
    command,
    working_directory: '/workspace/storefront',
    ...(background ? { background: true } : {}),
  });

export const passingTests = [
  ' RUN  v2.1.4 /workspace/storefront',
  '',
  ' ✓ src/checkout/checkout.test.tsx (6 tests) 182ms',
  ' ✓ src/checkout/total.test.ts (4 tests) 9ms',
  '',
  ' Test Files  2 passed (2)',
  '      Tests  10 passed (10)',
  '   Duration  1.94s',
];

export const failingTests = [
  ' FAIL  src/checkout/checkout.test.tsx > Checkout > uses the primary token',
  'AssertionError: expected "bg-white" to contain "bg-primary"',
  ' ❯ src/checkout/checkout.test.tsx:42:31',
];
