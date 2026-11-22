// The catalog index (spec `docs/designs/grpc-processes.md`, section 8, G5):
// the contracts, services and methods of a set of generated `DescFile`s, with
// the Doric options of `doric/platform/v1/options.proto` read into plain
// values. Phase 2 builds it from the `file_*` exports of `*_pb.js` modules;
// phase 3 builds it from `dist/descriptors.binpb`.

import {
  createRegistry,
  type DescFile,
  type DescMethod,
  type DescService,
  type FileRegistry,
  getOption,
  hasOption,
} from '@bufbuild/protobuf';

import {
  Cardinality,
  contract as contractOption,
  Environment,
  Expose,
  hooks as hooksOption,
  method as methodOption,
  ServiceRole,
  service as serviceOption,
} from '../contracts/gen/doric/platform/v1/options_pb.js';
import { isPlatformContract } from '../contracts/ids.js';

/**
 * Where a contract is served. `HOST` and `CLIENT` are the values of
 * `(doric.platform.v1.contract).environment` (`Environment.HOST`,
 * `Environment.CLIENT`). The other two are derived, since their files set no
 * environment: `PLATFORM` is a platform contract (`doric.*`, A52), served by
 * the platform where it runs; `HOOKS` is a hooks contract, a file with the
 * option `(doric.platform.v1.hooks)`, which the environment rule holds `HOST`
 * by its kind.
 */
export type ContractEnvironment = 'HOST' | 'CLIENT' | 'PLATFORM' | 'HOOKS';

/** A contract of the index: one file with the option `contract` or `hooks`. */
export interface ContractInfo {
  /** The contract id, `<name>/v<major>` (`tools/v1`, `doric.log/v1`). */
  readonly id: string;
  /**
   * `(doric.platform.v1.contract).cardinality`: `ONE` is `'one'`, `MANY` is
   * `'many'`. A hooks contract, whose option holds no cardinality, is `'one'`,
   * as the build records `defineHooks` today.
   */
  readonly cardinality: 'one' | 'many';
  /** Where the contract is served; see {@link ContractEnvironment}. */
  readonly environment: ContractEnvironment;
  /** The `.proto` file that defines the contract. */
  readonly file: DescFile;
}

/** A service of a contract file. */
export interface ServiceInfo {
  /** The generated service descriptor. */
  readonly service: DescService;
  /** The contract of the file that declares the service. */
  readonly contract: ContractInfo;
  /**
   * `(doric.platform.v1.service).role`: `'handler'` for
   * `SERVICE_ROLE_HANDLER` (implemented by the bundles that register with the
   * contract, called by its provider); `'contract'` when the option is unset
   * or `SERVICE_ROLE_UNSPECIFIED` (the contract's own service).
   */
  readonly role: 'contract' | 'handler';
  /** The service's methods, in declaration order. */
  readonly methods: readonly MethodInfo[];
}

/** A method of a contract service. */
export interface MethodInfo {
  /** The gRPC path, `/<service full name>/<method name>`. */
  readonly path: string;
  /** The generated descriptor of the method's service. */
  readonly service: DescService;
  /** The generated method descriptor. */
  readonly method: DescMethod;
  /** The method's streaming shape, from `DescMethod.methodKind`. */
  readonly kind: 'unary' | 'server_stream' | 'client_stream' | 'bidi';
  /** The contract of the file that declares the method's service. */
  readonly contract: ContractInfo;
  /** The role of the method's service; see {@link ServiceInfo.role}. */
  readonly role: 'contract' | 'handler';
  /**
   * `(doric.platform.v1.method).expose`: `'DESKTOP'` for `EXPOSE_DESKTOP`,
   * `'NONE'` when unset or `EXPOSE_UNSPECIFIED`.
   */
  readonly expose: 'NONE' | 'DESKTOP';
  /** `(doric.platform.v1.method).resumable`; false when unset. */
  readonly resumable: boolean;
}

/**
 * The read-only index of a set of descriptor files. Only contract files (a
 * file with the option `(doric.platform.v1.contract)` or
 * `(doric.platform.v1.hooks)`) contribute contracts, services and methods;
 * the files they import, such as `google/protobuf/*.proto` or
 * `options.proto`, are in `registry` only. Lookups never throw: an unknown
 * key answers `undefined`.
 */
export interface CatalogIndex {
  /** The method at a gRPC path `/<service full name>/<method name>`. */
  method(path: string): MethodInfo | undefined;
  /** The service with a full name, `doric.tools.v1.ToolsService`. */
  service(fullName: string): ServiceInfo | undefined;
  /** The contract with an id, `tools/v1`. */
  contract(id: string): ContractInfo | undefined;
  /**
   * Every method exposed to `DESKTOP`, in the order of the files given to
   * {@link createCatalogIndex}, then declaration order. The same array on
   * every call.
   */
  desktopMethods(): readonly MethodInfo[];
  /** Every file given and every file they import, transitively. */
  readonly registry: FileRegistry;
}

/**
 * Builds the index of `files` and of every file they import, transitively. A
 * file reached twice (given twice, or given and imported) counts once. The
 * index does not change after it is built.
 *
 * Throws a `TypeError` naming the file when the index cannot hold it: two
 * files declare one contract id; two different files have one name; a
 * contract's `cardinality` is `CARDINALITY_UNSPECIFIED`; a bundle's contract
 * (not `doric.*`) leaves `environment` unspecified; or a platform contract
 * sets one. These are rules of the proto check (`build/proto-rules.ts`), held
 * here too so that the index never answers a contract without a cardinality
 * and an environment.
 */
export const createCatalogIndex = (files: Iterable<DescFile>): CatalogIndex => {
  const byName = new Map<string, DescFile>();
  const ordered: DescFile[] = [];
  const visit = (file: DescFile): void => {
    const known = byName.get(file.proto.name);

    if (known === file) {
      return;
    }

    if (known !== undefined) {
      throw new TypeError(
        `${file.proto.name}: two different files have this name.`,
      );
    }

    byName.set(file.proto.name, file);
    ordered.push(file);

    for (const dependency of file.dependencies) {
      visit(dependency);
    }
  };

  for (const file of files) {
    visit(file);
  }

  const contracts = new Map<string, ContractInfo>();
  const services = new Map<string, ServiceInfo>();
  const methods = new Map<string, MethodInfo>();
  const desktop: MethodInfo[] = [];

  for (const file of ordered) {
    const info = contractOf(file);

    if (info === undefined) {
      continue;
    }

    const previous = contracts.get(info.id);

    if (previous !== undefined) {
      throw new TypeError(
        `${file.proto.name}: contract ${JSON.stringify(info.id)} is also declared by ${previous.file.proto.name}.`,
      );
    }

    contracts.set(info.id, info);

    for (const descriptor of file.services) {
      const role =
        getOption(descriptor, serviceOption).role === ServiceRole.HANDLER
          ? 'handler'
          : 'contract';
      const serviceMethods = descriptor.methods.map((rpc): MethodInfo => {
        const options = getOption(rpc, methodOption);

        return {
          path: `/${descriptor.typeName}/${rpc.name}`,
          service: descriptor,
          method: rpc,
          kind: kinds[rpc.methodKind],
          contract: info,
          role,
          expose: options.expose === Expose.DESKTOP ? 'DESKTOP' : 'NONE',
          resumable: options.resumable,
        };
      });

      services.set(descriptor.typeName, {
        service: descriptor,
        contract: info,
        role,
        methods: serviceMethods,
      });

      for (const entry of serviceMethods) {
        methods.set(entry.path, entry);

        if (entry.expose === 'DESKTOP') {
          desktop.push(entry);
        }
      }
    }
  }

  const types = createRegistry(...ordered);
  const registry: FileRegistry = {
    kind: 'registry',
    files: ordered,
    getFile: (fileName) => byName.get(fileName),
    [Symbol.iterator]: () => types[Symbol.iterator](),
    get: (typeName) => types.get(typeName),
    getMessage: (typeName) => types.getMessage(typeName),
    getEnum: (typeName) => types.getEnum(typeName),
    getExtension: (typeName) => types.getExtension(typeName),
    getExtensionFor: (extendee, no) => types.getExtensionFor(extendee, no),
    getService: (typeName) => types.getService(typeName),
  };

  return Object.freeze({
    method: (path: string) => methods.get(path),
    service: (fullName: string) => services.get(fullName),
    contract: (id: string) => contracts.get(id),
    desktopMethods: () => desktop,
    registry,
  });
};

const kinds: Readonly<Record<DescMethod['methodKind'], MethodInfo['kind']>> = {
  unary: 'unary',
  server_streaming: 'server_stream',
  client_streaming: 'client_stream',
  bidi_streaming: 'bidi',
};

/**
 * The contract `file` declares, or `undefined` for a file with neither the
 * option `contract` nor `hooks`. Throws the `TypeError` of
 * {@link createCatalogIndex} for an unspecified cardinality or environment.
 */
const contractOf = (file: DescFile): ContractInfo | undefined => {
  if (hasOption(file, hooksOption)) {
    return {
      id: getOption(file, hooksOption).id,
      cardinality: 'one',
      environment: 'HOOKS',
      file,
    };
  }

  if (!hasOption(file, contractOption)) {
    return undefined;
  }

  const option = getOption(file, contractOption);
  const name = file.proto.name;

  if (option.cardinality === Cardinality.UNSPECIFIED) {
    throw new TypeError(
      `${name}: contract ${JSON.stringify(option.id)} has no cardinality.`,
    );
  }

  let environment: ContractEnvironment;

  if (isPlatformContract(option.id)) {
    if (option.environment !== Environment.UNSPECIFIED) {
      throw new TypeError(
        `${name}: platform contract ${JSON.stringify(option.id)} sets an environment.`,
      );
    }

    environment = 'PLATFORM';
  } else if (option.environment === Environment.HOST) {
    environment = 'HOST';
  } else if (option.environment === Environment.CLIENT) {
    environment = 'CLIENT';
  } else {
    throw new TypeError(
      `${name}: contract ${JSON.stringify(option.id)} has no environment.`,
    );
  }

  return {
    id: option.id,
    cardinality: option.cardinality === Cardinality.ONE ? 'one' : 'many',
    environment,
    file,
  };
};
