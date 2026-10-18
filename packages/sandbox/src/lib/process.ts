import { StringDecoder } from 'node:string_decoder';

import type {
  SandboxExecResult,
  SandboxProcessInput,
} from './types/sandbox.js';

/** Shared bounded, UTF-8-safe capture for provider process transports. */
export const captureProcessOutput = (input: SandboxProcessInput) => {
  const decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const truncated = { stdout: false, stderr: false };
  const publish = (stream: 'stdout' | 'stderr', data: string) => {
    if (data.length > 0) input.onOutput?.({ stream, data });
  };
  return {
    append(stream: 'stdout' | 'stderr', chunk: Uint8Array) {
      truncated[stream] ||= buffers[stream].length + chunk.length > 1_048_576;
      buffers[stream] = Buffer.concat([buffers[stream], chunk]).subarray(
        -1_048_576,
      );
      publish(stream, decoders[stream].write(Buffer.from(chunk)));
    },
    finish(exitCode: number | null): SandboxExecResult {
      publish('stdout', decoders.stdout.end());
      publish('stderr', decoders.stderr.end());
      for (const stream of ['stdout', 'stderr'] as const) {
        if (!truncated[stream]) continue;
        const marker = Buffer.from('[earlier output truncated]\n');
        let bytes = buffers[stream].subarray(marker.length);
        while (bytes.length > 0 && ((bytes[0] ?? 0) & 0xc0) === 0x80)
          bytes = bytes.subarray(1);
        buffers[stream] = Buffer.concat([marker, bytes]);
      }
      return {
        exitCode,
        stdout: buffers.stdout.toString('utf8'),
        stderr: buffers.stderr.toString('utf8'),
        stdoutBytes: buffers.stdout,
        stderrBytes: buffers.stderr,
      };
    },
  };
};

/** Kills every process in the isolated session, including foreground job groups. */
export const processTerminationScript = (pidFile: string): string => `
if [ -r ${quote(pidFile)} ]; then
  leader=$(cat ${quote(pidFile)})
  case "$leader" in ''|*[!0-9]*) exit 1;; esac
  for entry in /proc/[0-9]*/stat; do
    IFS= read -r stat < "$entry" 2>/dev/null || continue
    fields=\${stat##*) }
    set -- $fields
    if [ "$4" = "$leader" ]; then
      pid=\${entry#/proc/}; pid=\${pid%/stat}
      [ "$pid" = "$leader" ] || kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  kill -KILL "$leader" 2>/dev/null || true
  rm -f ${quote(pidFile)}
fi`;

/** Single-quotes a value so it survives shell word splitting and expansion. */
export const quote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;
