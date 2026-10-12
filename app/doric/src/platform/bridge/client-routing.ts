// What a window of one generation may reach over the bridge (section 14.1):
// its `WindowCatalog` (client resolution, client part URLs, remote
// contracts) and the JSON Schemas main validates calls with.

import { readFileSync } from 'node:fs';

import type { JsonObject } from 'bundle/contracts';
import { isPlatformContract } from 'bundle/contracts';
import {
  type CatalogEntry,
  type DistributionBundle,
  type DistributionCatalog,
  descriptorSchema,
  documentExposure,
} from 'bundle/runtime';
import {
  type RemoteContract,
  type RemoteMethodSpec,
  remoteMethodSpecFromSchema,
  type WindowCatalog,
  type WindowMode,
  type WindowPart,
} from 'desktop/protocol';

import type { DesktopResolution } from '../catalog/resolve';
import { bundleUrl } from '../protocol/import-map';

/** One method's published schemas. */
export interface MethodSchemas {
  readonly input: JsonObject;
  readonly output: JsonObject;
}

/** A remote contract with the schemas main validates its calls against. */
export interface RoutedContract {
  readonly contract: RemoteContract;
  readonly schemas: Readonly<Record<string, MethodSchemas>>;
  /** The scope keys a window may send to this contract (`desktopScope` of its provider). */
  readonly scopeKeys: readonly string[];
}

/** Everything main keeps per generation for the windows pinned to it. */
export interface GenerationView {
  readonly generation: number;
  readonly mode: WindowMode;
  readonly catalog: DistributionCatalog;
  readonly resolution: DesktopResolution;
  /** Bundles by ID, as distributed. */
  readonly bundles: ReadonlyMap<string, DistributionBundle>;
  readonly windowCatalog: WindowCatalog;
  /** Contracts by ID: desktopMain providers first, then host providers. */
  readonly routes: ReadonlyMap<string, readonly RoutedContract[]>;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `<method>.input` / `<method>.output` of a contract document. */
export const methodSchemas = (
  document: JsonObject,
): Record<string, MethodSchemas> => {
  const defs = isObject(document.$defs) ? document.$defs : {};
  const methods: Record<string, MethodSchemas> = {};

  for (const key of Object.keys(defs)) {
    const match = /^(.+)\.input$/.exec(key);

    if (match === null) {
      continue;
    }

    const name = match[1] as string;
    const input = defs[key];
    const output = defs[`${name}.output`];

    methods[name] = {
      input: isObject(input) ? input : {},
      output: isObject(output) ? output : {},
    };
  }

  return methods;
};

export type SchemaReader = (
  bundle: DistributionBundle,
  path: string,
) => JsonObject | undefined;

/** Reads a schema file of a verified bundle from the artifact cache. */
export const cacheSchemaReader =
  (pathOf: (bundle: DistributionBundle, path: string) => string | undefined) =>
  (bundle: DistributionBundle, path: string): JsonObject | undefined => {
    if (!bundle.files.some((file) => file.path === path)) {
      return undefined;
    }

    const file = pathOf(bundle, path);

    if (file === undefined) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;

      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

const routedContract = (input: {
  readonly id: string;
  readonly environment: 'desktopMain' | 'host';
  readonly bundle: DistributionBundle;
  readonly read: SchemaReader;
}): RoutedContract | undefined => {
  const descriptor = descriptorSchema.safeParse(input.bundle.descriptor);

  if (!descriptor.success) {
    return undefined;
  }

  const entry = descriptor.data.contracts.find(
    (candidate) =>
      candidate.id === input.id && candidate.environment === input.environment,
  );

  if (entry === undefined) {
    return undefined;
  }

  const document = input.read(input.bundle, entry.schema);

  if (document === undefined) {
    return undefined;
  }

  // A malformed exposure leaves the contract unrouted: default deny.
  let exposed: ReturnType<typeof documentExposure>;

  try {
    exposed = documentExposure(document);
  } catch {
    return undefined;
  }

  const schemas = methodSchemas(document);
  const methods: Record<string, RemoteMethodSpec> = {};

  for (const [name, member] of Object.entries(schemas)) {
    methods[name] = remoteMethodSpecFromSchema(
      member.input,
      member.output,
      exposed[name],
    );
  }

  return {
    contract: {
      id: input.id,
      environment: input.environment,
      bundleId: input.bundle.id,
      version: input.bundle.version,
      contractVersion: entry.version,
      cardinality: entry.cardinality,
      methods,
    },
    schemas,
    scopeKeys: input.bundle.manifest?.desktopScope?.[input.id] ?? [],
  };
};

const hasClientPart = (
  entry: CatalogEntry,
  bundles: ReadonlyMap<string, DistributionBundle>,
): boolean =>
  entry.state === 'scheduled' &&
  bundles.get(entry.id)?.parts.client !== undefined;

/** The routes and window catalog of one generation. */
export const generationView = (input: {
  readonly generation: number;
  readonly mode: WindowMode;
  readonly catalog: DistributionCatalog;
  readonly resolution: DesktopResolution;
  readonly read: SchemaReader;
}): GenerationView => {
  const { catalog, resolution } = input;
  const bundles = new Map(catalog.bundles.map((bundle) => [bundle.id, bundle]));
  const routes = new Map<string, RoutedContract[]>();
  const add = (routed: RoutedContract | undefined) => {
    if (routed === undefined) {
      return;
    }

    const list = routes.get(routed.contract.id) ?? [];

    list.push(routed);
    routes.set(routed.contract.id, list);
  };

  for (const contract of resolution.desktopMain.contracts) {
    if (isPlatformContract(contract.id)) {
      continue;
    }

    for (const provider of contract.providers) {
      const bundle = bundles.get(provider.bundleId);

      if (bundle !== undefined) {
        add(
          routedContract({
            id: contract.id,
            environment: 'desktopMain',
            bundle,
            read: input.read,
          }),
        );
      }
    }
  }

  for (const contract of catalog.host.contracts) {
    if (isPlatformContract(contract.id) || contract.environment !== 'host') {
      continue;
    }

    for (const provider of contract.providers) {
      const bundle = bundles.get(provider.bundleId);

      if (bundle !== undefined) {
        add(
          routedContract({
            id: contract.id,
            environment: 'host',
            bundle,
            read: input.read,
          }),
        );
      }
    }
  }

  const parts: Record<string, WindowPart> = {};

  for (const entry of resolution.client.entries) {
    const bundle = bundles.get(entry.id);

    if (bundle === undefined || !hasClientPart(entry, bundles)) {
      continue;
    }

    parts[entry.id] = {
      entry: bundleUrl(bundle, bundle.parts.client as string),
      ...(bundle.parts.clientStyles === undefined
        ? {}
        : { styles: bundleUrl(bundle, bundle.parts.clientStyles) }),
    };
  }

  const windowCatalog: WindowCatalog = {
    generation: input.generation,
    resolved: resolution.client,
    parts,
    // One record per contract, the route `routeOf` takes: a contract the
    // same bundle provides in desktopMain and in the host (`hooks/v1`,
    // `log/v1`, `settings/v1` of the core) would otherwise be registered
    // twice in the window's directory, which refuses the second.
    remote: [...routes.values()].map(
      (list) =>
        (
          list.find((route) => route.contract.environment === 'desktopMain') ??
          (list[0] as RoutedContract)
        ).contract,
    ),
    hostId: catalog.storage?.hostId ?? '',
    storageGeneration: catalog.storage?.storageGeneration ?? 0,
  };

  return {
    generation: input.generation,
    mode: input.mode,
    catalog,
    resolution,
    bundles,
    windowCatalog,
    routes,
  };
};

/** The client entry of a bundle with an active client part, else undefined. */
export const clientPartOf = (
  view: GenerationView,
  bundleId: string,
): CatalogEntry | undefined => {
  const entry = view.resolution.client.entries.find(
    (candidate) => candidate.id === bundleId,
  );

  return entry !== undefined && hasClientPart(entry, view.bundles)
    ? entry
    : undefined;
};

const contractIdOf = (entry: string): string =>
  entry.includes('@') ? entry.slice(0, entry.lastIndexOf('@')) : entry;

/**
 * Whether a client part may use a contract [S8-23]: its manifest `requires`
 * plus every contract the bundle provides in any environment.
 */
export const mayUse = (entry: CatalogEntry, contract: string): boolean => {
  const manifest = entry.manifest;

  if (manifest === undefined) {
    return false;
  }

  return [
    ...manifest.requires,
    ...manifest.provides,
    ...(manifest.optional ?? []),
  ].some((declared) => contractIdOf(declared) === contract);
};

/** The route a client call takes: desktopMain first, then host. */
export const routeOf = (
  view: GenerationView,
  contract: string,
): RoutedContract | undefined => {
  const routes = view.routes.get(contract) ?? [];

  return (
    routes.find((route) => route.contract.environment === 'desktopMain') ??
    routes[0]
  );
};
