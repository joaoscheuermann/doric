import {
  type Call,
  ContractError,
  type ContractId,
  defineMethod,
  defineService,
  type MethodSpecs,
} from '../../src/contracts/index.js';

export type FakeMethod = (input: never, call: Call) => unknown;

/**
 * A provider of a basic contract built from its platform method table, so it
 * passes the shape check. Methods without a fake answer `unavailable`;
 * `omit` leaves methods out to exercise the shape check itself.
 */
export const basicProvider = (
  id: ContractId,
  specs: MethodSpecs,
  fakes: Readonly<Record<string, FakeMethod>> = {},
  omit: readonly string[] = [],
  options?: { readonly cardinality: 'many' },
) =>
  defineService(
    id,
    Object.fromEntries(
      Object.entries(specs)
        .filter(([name]) => !omit.includes(name))
        .map(([name, spec]) => [
          name,
          defineMethod({
            input: spec.input,
            output: spec.output,
            execute: (input: unknown, call: Call) => {
              const fake = fakes[name];

              if (fake === undefined) {
                throw new ContractError('unavailable', `${name} is not faked.`);
              }

              return (fake as (input: unknown, call: Call) => unknown)(
                input,
                call,
              );
            },
          }),
        ]),
    ),
    options,
  );
