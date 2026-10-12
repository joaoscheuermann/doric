import { readFileSync } from 'node:fs';

import {
  defineMethod,
  defineService,
  type LogFields,
  LogV1,
  logMethods,
  type ModelKindDescriptor,
  type ModelsProvider,
  ModelsProviderV1,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { HttpRequest, HttpTransport } from 'llms';

import { createActivate } from '../../src/host/index.js';

export interface Line {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields;
}

/**
 * The kind this bundle provided before the closed llms catalog was removed,
 * frozen from the llms kind catalog.
 */
export const frozenKind = (): ModelKindDescriptor =>
  JSON.parse(
    readFileSync(
      new URL('../../../tests/fixtures/provider-kind.json', import.meta.url),
      'utf8',
    ),
  ) as ModelKindDescriptor;

/** The bundle activated beside a log/v1 that keeps every line. */
export const providerWorld = async (
  bundleId: string,
  options: { transport?: HttpTransport } = {},
) => {
  const lines: Line[] = [];
  const level = (name: string) =>
    defineMethod({
      ...logMethods.debug,
      execute: ([message, fields]: [string, LogFields?]) => {
        lines.push({
          level: name,
          message,
          ...(fields === undefined ? {} : { fields }),
        });
      },
    });
  const world = createTestServices({
    bundle: { id: bundleId },
    provide: [
      defineService(LogV1, {
        debug: level('debug'),
        info: level('info'),
        warn: level('warn'),
        error: level('error'),
      }),
    ],
  });

  createActivate(
    options.transport === undefined
      ? {}
      : { transport: () => options.transport as HttpTransport },
  )({ services: world.services });

  const records: ModelsProvider[] = [];

  world.services.whenAvailable(ModelsProviderV1, (api) => {
    records.push(api);
  });

  const [provider] = records;

  if (provider === undefined || records.length !== 1) {
    await world.dispose();
    throw new Error('Expected exactly one models.provider/v1 record.');
  }

  return { world, lines, provider };
};

/** A transport that keeps every request and answers a one-model catalog. */
export const recordingTransport = (
  body: unknown = { data: [{ id: 'gpt-5' }] },
) => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: (request) => {
      requests.push(request);

      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify(body),
      });
    },
    stream: () => {
      throw new Error('No stream in these tests.');
    },
  };

  return { requests, transport };
};

/** A transport whose every request fails. */
export const failingTransport = (error: Error): HttpTransport => ({
  request: () => Promise.reject(error),
  stream: () => {
    throw new Error('No stream in these tests.');
  },
});
