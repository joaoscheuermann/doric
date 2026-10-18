// `<artifacts-settings-review>`, the Review section of the settings window:
// the Project's review policy, read and written through `artifacts/v1`. A
// custom element with its own shadow tree, not React: the story defines it
// and sets its services.

import { ARTIFACTS_REVIEW_TAG } from '../../src/client/index.js';
import { defineReviewElement } from '../../src/client/settings/review.js';
import { CustomElement } from '../support/element.js';
import type { ArtifactsHostOptions } from '../support/host.js';

function Review({ host }: { readonly host?: ArtifactsHostOptions }) {
  return (
    <div className="max-w-xl">
      <CustomElement
        tag={ARTIFACTS_REVIEW_TAG}
        define={defineReviewElement}
        {...(host === undefined ? {} : { host })}
      />
    </div>
  );
}

export default {
  title: 'Artifacts/Settings/Review policy',
  component: Review,
};

/** The Doric default: publish and move on. */
export const Proceed = {
  render: () => <Review />,
};

export const Request = {
  render: () => <Review host={{ policy: 'request' }} />,
};

export const ReadFailed = {
  render: () => <Review host={{ failRead: true }} />,
};

/** Choose the other policy: the write fails and the reading goes back. */
export const WriteFails = {
  render: () => <Review host={{ failWrite: true }} />,
};
