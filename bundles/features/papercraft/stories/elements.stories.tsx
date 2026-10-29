// The public element of the bundle, as the window defines it: the
// `<papercraft-preview>` body the artifacts frame mounts in the
// conversation. Each story defines the tag (once per window), then hands the
// element the story host and its block, as the platform does.

import type { Services } from 'bundle/contracts';
import { createElement, useEffect, useRef } from 'react';

import { definePreviewElement } from '../src/client/elements.js';
import {
  PAPERCRAFT_PREVIEW_TAG,
  PREVIEW_BLOCK_TYPE,
} from '../src/contracts/index.js';
import { checkoutPreview } from './support/checkout.js';
import { ChatColumn } from './support/frame.js';
import { type StoryHostOptions, useStoryHost } from './support/host.js';
import {
  ARTIFACT_ID,
  PROJECT_ID,
  THREAD_ID,
  TITLE,
} from './support/preview.js';

const defineTags = (): void => {
  if (customElements.get(PAPERCRAFT_PREVIEW_TAG) === undefined)
    customElements.define(PAPERCRAFT_PREVIEW_TAG, definePreviewElement());
};

/** The block the artifacts frame hands its body for one revision. */
const previewBlock = (revision: number) => ({
  id: `block-${ARTIFACT_ID}-${String(revision)}`,
  type: PREVIEW_BLOCK_TYPE,
  data: {
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    artifactId: ARTIFACT_ID,
    revision,
    kind: 'preview',
    title: TITLE,
    entries: checkoutPreview(revision).files,
  },
});

/** One element of the bundle, with the services and properties set on it. */
function Element({
  tag,
  properties,
  host,
}: {
  readonly tag: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly host?: StoryHostOptions;
}) {
  defineTags();

  const services = useStoryHost(host);
  const element = useRef<HTMLElement & { services?: Services }>(null);

  useEffect(() => {
    const node = element.current;

    if (node === null) return;

    Object.assign(node, properties);
    node.services = services;
  }, [services, properties]);

  return createElement(tag, { ref: element });
}

const PREVIEW_PROPERTIES = { block: previewBlock(2) };

export default {
  title: 'Papercraft/Elements/Preview elements',
  component: Element,
};

/** `<papercraft-preview>`: the node body of revision 2 in the conversation. */
export const PreviewNode = {
  render: () => (
    <ChatColumn>
      <Element
        tag={PAPERCRAFT_PREVIEW_TAG}
        properties={PREVIEW_PROPERTIES}
        host={{ revisions: 2 }}
      />
    </ChatColumn>
  ),
};

/** A block the element cannot read renders nothing. */
export const InvalidBlock = {
  render: () => (
    <ChatColumn>
      <Element
        tag={PAPERCRAFT_PREVIEW_TAG}
        properties={{ block: { id: 'block-1', type: PREVIEW_BLOCK_TYPE } }}
      />
    </ChatColumn>
  ),
};
