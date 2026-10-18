import { isDeepStrictEqual } from 'node:util';

import { numberValue, recordValue, stringValue } from './mapping.js';
import type { ContainerInspect, CreateContainerInput } from './types/docker.js';

/**
 * Whether a container that served a workspace before can serve the request
 * now. The request and the container are both read through `settingsOf`: the
 * create body is first given the inspect shape it names, so one set of rules
 * compares them. A setting the container does not report differs from the
 * request, so a container with incomplete metadata is rebuilt, not trusted.
 */
export const reusable = (
  spec: CreateContainerInput,
  inspect: ContainerInspect,
): boolean =>
  isDeepStrictEqual(settingsOf(asInspectShape(spec)), settingsOf(inspect.raw));

/** The inspect shape a create body describes: its settings under Config and HostConfig. */
const asInspectShape = (
  spec: CreateContainerInput,
): Record<string, unknown> => ({
  Config: {
    Image: spec.image,
    WorkingDir: spec.workingDir,
    Labels: spec.labels,
    ExposedPorts: Object.fromEntries(
      (spec.exposedPorts ?? []).map((port) => [port, {}]),
    ),
  },
  HostConfig: spec.hostConfig,
});

/**
 * The settings that decide reuse. Absent lists and maps read as empty, which is
 * how Docker reports "none"; a scalar that is absent stays undefined and so
 * never matches a requested value.
 */
const settingsOf = (raw: Record<string, unknown>) => {
  const config = recordValue(raw.Config);
  const host = recordValue(raw.HostConfig);

  return {
    image: stringValue(config.Image),
    workingDir: stringValue(config.WorkingDir),
    labels: textRecord(config.Labels),
    exposedPorts: Object.keys(recordValue(config.ExposedPorts)).sort(),
    networkMode: stringValue(host.NetworkMode),
    memory: numberValue(host.Memory),
    nanoCpus: numberValue(host.NanoCpus),
    storageSize: stringValue(recordValue(host.StorageOpt).size),
    dns: textList(host.Dns),
    binds: textList(host.Binds),
    portBindings: portBindingsOf(host.PortBindings),
  };
};

const textRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(recordValue(value)).flatMap(([key, text]) =>
      typeof text === 'string' ? [[key, text]] : [],
    ),
  );

const textList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const portBindingsOf = (value: unknown) =>
  Object.fromEntries(
    Object.entries(recordValue(value)).map(([port, bindings]) => [
      port,
      Array.isArray(bindings)
        ? bindings.map((binding) => {
            const record = recordValue(binding);

            return {
              hostIp: stringValue(record.HostIp),
              hostPort: stringValue(record.HostPort),
            };
          })
        : undefined,
    ]),
  );
