// Dev-only: what the fake host prints. One line per call, so a boot that asks
// for a contract the fake host does not serve is visible at a glance.

const MAX_INPUT = 160;

const time = () => new Date().toISOString().slice(11, 23);

const format = (input) => {
  let text;

  try {
    text = JSON.stringify(input);
  } catch {
    text = String(input);
  }

  if (text === undefined) return '(none)';

  return text.length > MAX_INPUT ? `${text.slice(0, MAX_INPUT)}…` : text;
};

const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);

export const createLog = ({ quiet = false } = {}) => {
  const write = (line) => process.stdout.write(`[fake-host] ${line}\n`);

  return {
    /** A lifecycle or REST line. Always printed: it is the boot record. */
    note: (message) => write(`${time()} ${message}`),
    call: (contract, method, input) => {
      if (quiet) return;

      write(`${time()} → ${contract} ${method} ${format(input)}`);
    },
    answered: (contract, method, ms) => {
      if (quiet) return;

      write(`${time()} ✓ ${contract} ${method} (${ms} ms)`);
    },
    failed: (contract, method, error) =>
      write(`${time()} ✗ ${contract} ${method}: ${messageOf(error)}`),
    /** A call no handler answers: the loudest line, since it names the gap. */
    unknownCall: (contract, method, input) =>
      write(
        `${time()} ?? UNKNOWN ${contract} ${method} ${format(input)} → unavailable`,
      ),
  };
};
