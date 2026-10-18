// The `artifacts` client part.
//
// It defines `<artifacts-node>` — the registry's frame, which mounts the
// kind's body — and registers,
// through `chat.views/v1` (`whenAvailable`, as the `threads` and `papercraft`
// clients do), the renderer of the frame block type and the projector of
// `artifacts.*`: one frame block per revision, for every kind.
//
// A kind provides its body by declaring `bodyTag` (and `blockType`) in
// `artifact.kind/v1`; the frame creates that element with the frame's block.
// A legacy kind — one that declares a `blockType` but no `bodyTag` — still
// projects created/revised itself, and `chat.views/v1` claims are exclusive,
// so in a window where one stands this bundle claims only the review pair
// (`approved`/`applied`) and leaves created/revised to it.
import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  NavigationV1,
  type RegionItem,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';

import {
  type ArtifactKindDescriptor,
  ArtifactKindV1,
} from '../contracts/index.js';
import { ChatViewsV1 } from './chat-contract.js';
import { ARTIFACTS_NODE_TAG, defineFrameElement } from './elements.js';
import {
  ARTIFACT_EVENT_TYPES,
  ARTIFACT_FRAME_BLOCK_TYPE,
  ARTIFACT_REVIEW_EVENT_TYPES,
  createArtifactsProjector,
} from './projector.js';
import { defineReviewElement } from './settings/review.js';

/** The Review section's element tag, drawn inside the settings window. */
export const ARTIFACTS_REVIEW_TAG = 'artifacts-settings-review';

/** The route of the Review section, a child of the settings window's. */
export const ARTIFACTS_REVIEW_PATH = '/settings/review';

/**
 * The region items of this bundle: the Review link in the settings window's
 * nav (`settings.sections`, the same region the `git` bundle's Versioning
 * link occupies at order 40). The section's heading comes from this link
 * (R-9.8): its label names the page its route shows.
 */
export const artifactsRegions: readonly {
  readonly region: string;
  readonly item: RegionItem;
}[] = [
  {
    region: 'settings.sections',
    item: {
      id: 'review',
      tag: 'settings-link',
      order: 60,
      props: {
        label: 'Review',
        path: ARTIFACTS_REVIEW_PATH,
        icon: 'zap',
        description:
          'Como o Project revisa os artefatos do agente: seguir direto ou esperar a autorização.',
      },
    },
  },
];

/**
 * Whether a legacy kind stands: one with a `blockType` but no `bodyTag`
 * projects and renders its own node instead of a body inside the frame.
 */
const legacyKindStands = (kinds: readonly ArtifactKindDescriptor[]): boolean =>
  kinds.some(
    (kind) => kind.blockType !== undefined && kind.bodyTag === undefined,
  );

export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);
  const disposables: Disposable[] = [];

  disposables.push(ui.define(ARTIFACTS_NODE_TAG, defineFrameElement()));
  disposables.push(ui.define(ARTIFACTS_REVIEW_TAG, defineReviewElement()));

  // The Review section's place in the settings window: one link in the nav's
  // `settings.sections` region and one child route of `/settings`, the same
  // surfaces the `git` bundle's Versioning section occupies (WP-10N).
  const regions = services.use(RegionsV1);
  const navigation = services.use(NavigationV1);

  for (const { region, item } of artifactsRegions) {
    disposables.push(regions.add(region, item));
  }

  disposables.push(
    navigation.register({
      path: ARTIFACTS_REVIEW_PATH,
      parent: '/settings',
      create: () => ui.create(ARTIFACTS_REVIEW_TAG),
    }),
  );

  const views = services.whenAvailable(ChatViewsV1, (chat) => {
    const claimed: Disposable[] = [];
    let ended = false;

    const track = (registration: Disposable): void => {
      if (ended) registration.dispose();
      else claimed.push(registration);
    };

    track(
      chat.registerRenderer({
        blockType: ARTIFACT_FRAME_BLOCK_TYPE,
        elementTag: ARTIFACTS_NODE_TAG,
      }),
    );

    // The kinds the host registered decide what this bundle claims: all of
    // `artifacts.*`, or — beside a legacy kind — the review pair alone. The
    // registry is host state, complete before any window client part
    // activates.
    void services
      .use(ArtifactKindV1)
      .list()
      .then(
        (kinds) => {
          try {
            track(
              chat.registerProjector(
                createArtifactsProjector(
                  legacyKindStands(kinds)
                    ? ARTIFACT_REVIEW_EVENT_TYPES
                    : ARTIFACT_EVENT_TYPES,
                ),
              ),
            );
          } catch {
            // Another bundle claimed these types first; its projection
            // stands, and the frame renderer above still draws its block type.
          }
        },
        () => undefined,
      );

    return () => {
      ended = true;

      for (const registration of claimed) registration.dispose();
    };
  });
  disposables.push(views);

  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}

export { ChatViewsV1 } from './chat-contract.js';
export {
  CommentsV1,
  type CommentTargetKey,
} from './comments-contract.js';
export {
  ARTIFACTS_COMMENT_EVENT,
  ARTIFACTS_NODE_TAG,
  type ArtifactCommentDetail,
  defineFrameElement,
} from './elements.js';
export {
  ARTIFACT_EVENT_TYPES,
  ARTIFACT_FRAME_BLOCK_TYPE,
  ARTIFACT_REVIEW_EVENT_TYPES,
  type ArtifactFrameData,
  createArtifactsProjector,
  frameDataOf,
} from './projector.js';
export {
  type ArtifactProjection,
  type ArtifactRevisionProjection,
  type ArtifactsProjectionState,
  initialArtifactsState,
  projectionOf,
  reduceArtifactEvent,
  reduceArtifacts,
} from './reduce.js';
export { defineReviewElement } from './settings/review.js';
