import type { Call, Services } from 'bundle/contracts';

/** The scope every preview call carries in the tests. */
export const testCall = { scope: { projectId: 'p1' } } as unknown as Call;

/**
 * A services stub for the host tests: `use` answers by contract ID, so a test
 * supplies exactly the `files/v1` and `artifacts/v1` implementations it needs.
 */
export const servicesFor = (apiOf: (id: string) => unknown): Services =>
  ({
    provide: () => ({ dispose: () => undefined }),
    use: (contract: unknown) => apiOf((contract as { id?: string }).id ?? ''),
    whenAvailable: () => ({ dispose: () => undefined }),
  }) as unknown as Services;
