import { spawn } from 'node:child_process';

/** Execute argv without a shell; preserve the command exit status. */
export const command = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      ...options,
    });
    let output = '';

    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.once('error', reject);

    child.once('close', (code) => {
      if (code !== 0 && !options.allowFailure) {
        reject(new Error(file + ' exited ' + code));

        return;
      }

      resolve({ code: code ?? 1, output: output.trim() });
    });
  });
