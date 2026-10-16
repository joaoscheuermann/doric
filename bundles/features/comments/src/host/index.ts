// The `comments` bundle's host part: it provides the registry (`comments/v1`)
// and registers the two durable events. Activation does no data work — a
// comment is written when a caller adds one, and its durable record is the
// event the append leaves in the Thread log.

import { EventsV1, type HostContext } from 'bundle/contracts';

import {
  commentsAddedEvent,
  commentsResolvedEvent,
} from '../contracts/index.js';
import { commentsService } from './comments.js';

export const activate = ({ services }: HostContext): void => {
  services.provide(commentsService());

  const events = services.use(EventsV1);

  events.register(commentsAddedEvent);
  events.register(commentsResolvedEvent);
};
