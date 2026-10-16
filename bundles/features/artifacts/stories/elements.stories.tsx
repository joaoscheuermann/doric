// `<artifacts-node>`, the registry's frame, as the conversation shows it for
// one artifact revision: the bar (title, kind, revision, review state,
// `Autorizar` under `request`, `Comentar` with what is pending) around the
// kind's body. The frame is a custom element with its own shadow tree, not
// React: the story defines it and sets its services and block.

import {
  ARTIFACTS_NODE_TAG,
  defineFrameElement,
} from '../src/client/elements.js';
import { CustomElement } from './support/element.js';
import {
  type ArtifactsHostOptions,
  PLAN_KIND,
  planBlock,
} from './support/host.js';

const BLOCK = { block: planBlock() };

function Frame({
  host,
  properties = BLOCK,
  services,
}: {
  readonly host?: ArtifactsHostOptions;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly services?: null;
}) {
  return (
    <CustomElement
      tag={ARTIFACTS_NODE_TAG}
      define={defineFrameElement}
      properties={properties}
      {...(host === undefined ? {} : { host })}
      {...(services === undefined ? {} : { services })}
    />
  );
}

export default {
  title: 'Artifacts/Elements/Frame',
  component: Frame,
};

/** A revision of a kind with a body, under `proceed`, with pending comments. */
export const WithBody = {
  render: () => <Frame host={{ pending: 2 }} />,
};

export const NoComments = {
  render: () => <Frame />,
};

/** Under `request`, an open revision: `Autorizar` in the bar. */
export const ApprovalNeeded = {
  render: () => <Frame host={{ policy: 'request', pending: 1 }} />,
};

export const Approved = {
  render: () => <Frame host={{ policy: 'request', approved: true }} />,
};

/** A kind whose body draws its own header: the bar goes, `Autorizar` stays below. */
export const BodyHeader = {
  render: () => (
    <Frame
      host={{
        policy: 'request',
        kinds: [{ ...PLAN_KIND, header: 'body' }],
      }}
    />
  ),
};

/** No active bundle declares the kind: the frame lists the revision's entries. */
export const Orphan = {
  render: () => (
    <Frame
      host={{ kinds: [] }}
      properties={{ block: planBlock({ kind: 'diagram' }) }}
    />
  ),
};

/** A first revision. */
export const FirstRevision = {
  render: () => <Frame properties={{ block: planBlock({ revision: 1 }) }} />,
};

/** A window without the host's services. */
export const WithoutServices = {
  render: () => <Frame services={null} />,
};
