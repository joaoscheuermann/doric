// The `artifacts` bundle's host part: it provides the registry (`artifacts/v1`)
// and the kind registry (`artifact.kind/v1`), registers the four durable events
// and the review policy setting. The two registries share one state: a payload
// a caller sends instead of ready entries is validated and materialized by the
// provider of the kind it registered. Activation does no data work: the
// Project's sandbox is reached per call, through the calling Project's lease.

import { EventsV1, type HostContext, SettingsV1 } from 'bundle/contracts';

import {
  artifactReviewPolicy,
  artifactsAppliedEvent,
  artifactsApprovedEvent,
  artifactsCreatedEvent,
  artifactsRevisedEvent,
} from '../contracts/index.js';
import { artifactsService } from './artifacts.js';
import { artifactKindService, createArtifactKindRegistry } from './kinds.js';

export const activate = ({ services }: HostContext): void => {
  const kinds = createArtifactKindRegistry();

  services.provide(artifactKindService(kinds));
  services.provide(artifactsService(kinds));

  const events = services.use(EventsV1);

  events.register(artifactsCreatedEvent);
  events.register(artifactsRevisedEvent);
  events.register(artifactsAppliedEvent);
  events.register(artifactsApprovedEvent);

  services.use(SettingsV1).register(artifactReviewPolicy);
};
