// The `drawio` host part's activation, at the registrations it makes with
// the host: the `diagram` kind in `artifact.kind/v1`, the `drawio_diagram`
// tool in `tools/v1` at its global position, and the `drawio.diagrams/v1`
// service; the cleanup releases the kind.
//
// Contract matrix (spec "Ativação", plan §5 K1–K3).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { HostContext, Services } from 'bundle/contracts';

import { activate } from '../src/host/index.js';

interface Recorded {
  readonly provided: { readonly id?: string }[];
  readonly kinds: Record<string, unknown>[];
  readonly tools: {
    readonly tool: { readonly name?: string };
    readonly options: unknown;
  }[];
  disposed: number;
}

/** The host as a bundle sees it during activation: registries that record. */
const host = () => {
  const recorded: Recorded = {
    provided: [],
    kinds: [],
    tools: [],
    disposed: 0,
  };
  const services = {
    provide: (service: { readonly id?: string }) => {
      recorded.provided.push(service);

      return { dispose: () => undefined };
    },
    use: (contract: { readonly id?: string }) => {
      switch (contract.id) {
        case 'artifact.kind/v1':
          return {
            register: async (input: Record<string, unknown>) => {
              recorded.kinds.push(input);

              return {
                dispose: () => {
                  recorded.disposed += 1;
                },
              };
            },
          };
        case 'tools/v1':
          return {
            register: (tool: { readonly name?: string }, options: unknown) => {
              recorded.tools.push({ tool, options });

              return { dispose: () => undefined };
            },
          };
        default:
          throw new Error(`unexpected contract ${String(contract.id)}`);
      }
    },
    whenAvailable: () => ({ dispose: () => undefined }),
  } as unknown as Services;

  return { recorded, context: { services } as unknown as HostContext };
};

describe('drawio host activation', () => {
  test('K1: registers the diagram kind with its body and no payload or materialize', async () => {
    const { recorded, context } = host();

    await activate(context);

    assert.deepEqual(recorded.kinds, [
      {
        id: 'diagram',
        title: 'Diagrama',
        blockType: 'drawio.diagram/v1',
        bodyTag: 'drawio-diagram',
        header: 'body',
      },
    ]);
  });

  test('K2: registers drawio_diagram, always available, at order 1750', async () => {
    const { recorded, context } = host();

    await activate(context);

    assert.equal(recorded.tools.length, 1);
    assert.equal(recorded.tools[0]?.tool.name, 'drawio_diagram');
    assert.deepEqual(recorded.tools[0]?.options, {
      alwaysAvailable: true,
      order: 1750,
    });
  });

  test('K3: provides drawio.diagrams/v1, and the cleanup releases the kind', async () => {
    const { recorded, context } = host();

    const cleanup = await activate(context);

    assert.deepEqual(
      recorded.provided.map((service) => service.id),
      ['drawio.diagrams/v1'],
    );
    assert.equal(recorded.disposed, 0);
    await cleanup();
    assert.equal(recorded.disposed, 1);
  });
});
