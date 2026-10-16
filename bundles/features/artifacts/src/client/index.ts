// The `artifacts` client part.
//
// It defines `<artifacts-node>` — the registry's generic frame — and
// `<artifacts-revisions>`, the revision list, and registers, through
// `chat.views/v1` (`whenAvailable`, as the `threads` and `papercraft` clients
// do), the renderer that draws the frame block type.
//
// The projector of `artifacts.created/v1` / `artifacts.revised/v1` is
// registered only when no kind bundle owns a node surface of its own: a kind
// that declared a `blockType` in `artifact.kind/v1` has its own client part —
// its projector claims the pair and its renderer draws the block (as
// `papercraft`'s does for `preview`), and `chat.views/v1` claims are
// exclusive, so registering this projector beside it would break that
// bundle's activation. In a window where no such kind exists, this bundle
// claims the pair and projects the frame for every artifact; in one where a
// kind bundle stands, the frame block type still resolves to this renderer,
// should a composition choose to draw it.

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
import { defineFrameElement, defineRevisionsElement } from './elements.js';
import {
  ARTIFACT_FRAME_BLOCK_TYPE,
  createArtifactsProjector,
} from './projector.js';
import { defineReviewElement } from './settings/review.js';

/** The node element tag; every tag this bundle defines carries its prefix. */
export const ARTIFACTS_NODE_TAG = 'artifacts-node';

/** The revision list element tag. */
export const ARTIFACTS_REVISIONS_TAG = 'artifacts-revisions';

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

/** Whether a kind owns its own node surface: a declared `blockType` names one. */
const ownsNodeSurface = (kinds: readonly ArtifactKindDescriptor[]): boolean =>
  kinds.some((kind) => kind.blockType !== undefined);

export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);
  const disposables: Disposable[] = [];

  disposables.push(ui.define(ARTIFACTS_NODE_TAG, defineFrameElement()));
  disposables.push(
    ui.define(ARTIFACTS_REVISIONS_TAG, defineRevisionsElement()),
  );
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

    // The kinds the host registered decide who projects the pair: one with a
    // `blockType` owns its node surface, so this bundle leaves the pair to its
    // bundle's client. The registry is host state, complete before any window
    // client part activates.
    void services
      .use(ArtifactKindV1)
      .list()
      .then(
        (kinds) => {
          if (ownsNodeSurface(kinds)) return;

          try {
            track(chat.registerProjector(createArtifactsProjector()));
          } catch {
            // Another bundle claimed the pair first; its projection stands,
            // and the frame renderer above still draws the block type it names.
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
  defineFrameElement,
  defineRevisionsElement,
} from './elements.js';
export {
  ARTIFACT_FRAME_BLOCK_TYPE,
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
