#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pino from 'pino';
import pretty from 'pino-pretty';

import { createFetchTransport, createLmStudioProvider } from 'llms';
import { generate, isOkfError } from 'okf';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const model = process.argv[2]?.trim();

const logger = pino(
  {
    redact: {
      paths: [
        'token',
        '*.token',
        'apiKey',
        '*.apiKey',
        'authorization',
        '*.authorization',
        'headers.authorization',
        '*.headers.authorization',
      ],
      censor: '[Redacted]',
    },
  },
  pretty({
    colorize: process.stderr.isTTY === true,
    destination: 2,
  }),
);

const progress = (activity) => {
  switch (activity.event) {
    case 'okf.generate.start':
      logger.info(
        activity,
        `Starting OKF generation (batch size ${activity.batchSize})`,
      );

      return;

    case 'okf.file.start':
      logger.info(activity, `Inspecting ${activity.source}`);

      return;

    case 'okf.file.cache.miss':
      logger.info(
        activity,
        `Cache miss for ${activity.source}; starting three-step generation`,
      );

      return;

    case 'okf.file.summary.start':
      logger.info(
        activity,
        `Summarizing ${activity.source} from source evidence`,
      );

      return;

    case 'okf.file.summary.complete':
      logger.info(activity, `Source analysis ready for ${activity.source}`);

      return;

    case 'okf.file.description.start':
      logger.info(activity, `Writing description for ${activity.source}`);

      return;

    case 'okf.file.description.complete':
      logger.info(activity, `Validated description for ${activity.source}`);

      return;

    case 'okf.file.tags.start':
      logger.info(activity, `Selecting tags for ${activity.source}`);

      return;

    case 'okf.file.tags.complete':
      logger.info(activity, `Validated tags for ${activity.source}`);

      return;

    case 'okf.file.cached':
      logger.info(
        activity,
        `Cache hit for ${activity.source}; reusing concept (${activity.processed} processed)`,
      );

      return;

    case 'okf.file.generated':
      logger.info(
        activity,
        `Generated concept for ${activity.source} (${activity.processed} processed)`,
      );

      return;

    case 'okf.index.start':
      logger.info(
        activity,
        `Building project index from ${activity.files} files`,
      );

      return;

    case 'okf.index.complete':
      logger.info(
        activity,
        `Project index written for ${activity.files} files`,
      );

      return;

    case 'okf.generate.complete':
      logger.info(
        activity,
        `OKF generation complete: ${activity.files} files, ${activity.generated} generated, ${activity.cached} cached`,
      );

      return;

    default:
      throw new Error('Unsupported OKF progress event');
  }
};

if (!model) {
  logger.error('Usage: npm run okf -- <model-id>');

  process.exitCode = 1;
} else {
  try {
    const provider = createLmStudioProvider({
      transport: createFetchTransport(),
      logger: pino({ enabled: false }),
    });

    await generate({ provider, model, progress }, ROOT_DIR);
  } catch (error) {
    if (isOkfError(error)) {
      logger.error(
        {
          code: error.code,
          stage: error.stage,
          ...(error.source === undefined ? {} : { source: error.source }),
          hint: error.hint,
        },
        error.message,
      );
    } else if (error instanceof DOMException && error.name === 'AbortError') {
      logger.warn('OKF generation cancelled');
    } else {
      logger.error(
        { hint: 'Retry the operation or report the failure.' },
        'OKF generation failed unexpectedly',
      );
    }

    process.exitCode = 1;
  }
}
