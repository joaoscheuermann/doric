// A fake host for the artifacts stories: the `Services` the registry's
// elements read, answered in memory — no bridge, no network. The frame reads
// the kinds (`artifact.kind/v1`), the revisions and the review policy
// (`artifacts/v1`), the pending comments (`comments/v1`) and makes the kind's
// body through `ui/v1`; the review section reads and writes the policy.

import type { Services } from 'bundle/contracts';

import type {
  ArtifactKindDescriptor,
  ArtifactRecord,
  ArtifactReviewPolicyValue,
} from '../../src/contracts/index.js';

export const PROJECT_ID = 'doric-web';
export const THREAD_ID = 'thread-checkout-redesign';

/** An ISO time `minutes` before now. */
export const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** The plan artifact the frame stories show, at its second revision. */
export const PLAN = {
  artifactId: 'plan-checkout-2c91',
  kind: 'plan',
  title: 'Checkout redesign plan',
  revisions: 2,
  entries: [
    { path: 'plan.md', sha256: '3b7e0c9d41a2f6e85c1d0a9b7e3f2c4d' },
    { path: 'diagram.svg', sha256: 'a41f9e2c7b3d5e6f8a0b1c2d3e4f5a6b' },
  ],
} as const;

/** The block chat hands `<artifacts-node>` for one revision. */
export const planBlock = (
  overrides: { readonly kind?: string; readonly revision?: number } = {},
) => {
  const revision = overrides.revision ?? PLAN.revisions;

  return {
    id: `block-${PLAN.artifactId}-${String(revision)}`,
    type: 'artifacts.revision/v1',
    data: {
      artifactId: PLAN.artifactId,
      revision,
      kind: overrides.kind ?? PLAN.kind,
      title: PLAN.title,
      targets: [{ path: 'src/components/Checkout.tsx', line: 10 }],
      entries: PLAN.entries,
      changeNote: 'Split the payment step out of the summary.',
      createdAt: minutesAgo(12),
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
    },
  };
};

const recordOf = (revision: number, approved: boolean): ArtifactRecord => ({
  artifactId: PLAN.artifactId,
  kind: PLAN.kind,
  title: PLAN.title,
  revision,
  revisions: PLAN.revisions,
  targets: [{ path: 'src/components/Checkout.tsx', line: 10 }],
  entries: PLAN.entries,
  state: approved ? 'approved' : 'open',
  createdAt: minutesAgo(40),
  createdBy: 'agent',
});

/**
 * The body a kind's client would define for its `bodyTag`: here a plain
 * element drawn from the block's data, as `ui/v1.create` hands it back.
 */
const planBody = (props?: Readonly<Record<string, unknown>>): HTMLElement => {
  const block = props?.block as
    | { readonly data?: { readonly changeNote?: string } }
    | undefined;
  const body = document.createElement('div');
  body.setAttribute(
    'style',
    'border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; display: grid; gap: 6px; font-size: 13px; background: var(--card); color: var(--card-foreground);',
  );
  body.innerHTML = [
    '<strong>1. Summary card</strong>',
    '<span>Keep the line items and the total; drop the coupon field.</span>',
    '<strong>2. Payment step</strong>',
    '<span>Move the card form to its own step after the summary.</span>',
    `<em style="color: var(--muted-foreground)">${block?.data?.changeNote ?? ''}</em>`,
  ].join('');

  return body;
};

export interface ArtifactsHostOptions {
  /** The kinds the composition declares; `plan` draws a body by default. */
  readonly kinds?: readonly ArtifactKindDescriptor[];
  readonly policy?: ArtifactReviewPolicyValue['policy'];
  readonly approved?: boolean;
  /** How many comments are still pending on the revision on screen. */
  readonly pending?: number;
  /** The review section's read fails, or its write does. */
  readonly failRead?: boolean;
  readonly failWrite?: boolean;
}

/** The `plan` kind as its bundle declares it: a body of its own. */
export const PLAN_KIND: ArtifactKindDescriptor = {
  id: 'plan',
  title: 'Plan',
  blockType: 'plan.body/v1',
  bodyTag: 'plan-body',
};

const disposable = (dispose: () => void) => ({ dispose });

export const artifactsHost = (options: ArtifactsHostOptions = {}): Services => {
  let policy = options.policy ?? 'proceed';
  let approved = options.approved === true;
  const kinds = options.kinds ?? [PLAN_KIND];
  const comments = Array.from({ length: options.pending ?? 0 }, (_, index) => ({
    commentId: `comment-${String(index + 1)}`,
    target: { kind: 'artifact', id: PLAN.artifactId, revision: PLAN.revisions },
    text: 'Keep the coupon field, it is in the spec.',
    resolved: false,
    createdAt: minutesAgo(5 + index),
  }));

  const apis: Record<string, unknown> = {
    'artifact.kind/v1': { list: () => Promise.resolve(kinds) },
    'artifacts/v1': {
      revisions: () =>
        Promise.resolve(
          Array.from({ length: PLAN.revisions }, (_, index) =>
            recordOf(index + 1, approved && index + 1 === PLAN.revisions),
          ),
        ),
      policy: () =>
        options.failRead === true
          ? Promise.reject(new Error('the Project has no lease'))
          : Promise.resolve({ policy }),
      setPolicy: (value: ArtifactReviewPolicyValue) => {
        if (options.failWrite === true)
          return Promise.reject(new Error('the settings space is read-only'));

        policy = value.policy;

        return Promise.resolve({ policy });
      },
      approve: () => {
        approved = true;

        return Promise.resolve(recordOf(PLAN.revisions, true));
      },
    },
    'comments/v1': { list: () => Promise.resolve(comments) },
    'ui/v1': {
      create: (_tag: string, props?: Readonly<Record<string, unknown>>) =>
        planBody(props),
      dispose: () => undefined,
      define: () => disposable(() => undefined),
    },
  };

  return {
    provide: () => disposable(() => undefined),
    use: (contract: unknown) => {
      const id = (contract as { readonly id?: string }).id ?? '';
      const api = apis[id];

      if (api === undefined) throw new Error(`${id} is not in the story host`);

      return api;
    },
    whenAvailable: () => disposable(() => undefined),
  } as unknown as Services;
};
