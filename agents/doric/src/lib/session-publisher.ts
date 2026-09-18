import type { Session, SessionEvent } from './sessions.js';

export type SessionPublisher = {
  event(value: SessionEvent): void;

  updated(value: Session): void;

  deleted(id: string): void;
};
