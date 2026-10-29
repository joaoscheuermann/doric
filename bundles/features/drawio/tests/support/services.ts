import type { Call, Services } from 'bundle/contracts';

/** The scope every tool and service call carries in the tests. */
export const testCall = {
  scope: { projectId: 'p1', threadId: 't1', promptId: 'q1' },
} as unknown as Call;

/** The host contracts the real host refuses without a Project scope. */
const PROJECT_SCOPED = new Set(['artifacts/v1', 'comments/v1']);

/**
 * A services stub for the host tests: `use` answers by contract ID, so a test
 * supplies exactly the implementations it needs. Like the real host, a
 * Project-bound contract used without a `projectId` in its scope is refused.
 */
export const servicesFor = (apiOf: (id: string) => unknown): Services =>
  ({
    provide: () => ({ dispose: () => undefined }),
    use: (contract: unknown, scope?: { projectId?: string }) => {
      const id = (contract as { id?: string }).id ?? '';

      if (PROJECT_SCOPED.has(id) && scope?.projectId === undefined) {
        throw new Error(`${id} used without a projectId scope`);
      }

      return apiOf(id);
    },
    whenAvailable: () => ({ dispose: () => undefined }),
  }) as unknown as Services;
