// The account bound to its fake host for one story or test (spec section 9):
// `activate` runs with the fake services, and the children render once it is
// in place. Leaving runs the activation's cleanup, so the next binding starts
// from nothing.

import { type ReactNode, useLayoutEffect, useState } from 'react';

import { activate } from '../../src/client/index.js';
import {
  createFakeHost,
  type FakeHost,
  type HostOptions,
} from './fake-host.js';

/** What a story or a test seeds: the slots' items and the absent contracts. */
export type AccountFixture = HostOptions;

let unbindCurrent: (() => void) | undefined;

/**
 * Activates the account on a fake host built from `fixture`. Returns the
 * host and the unbind, which runs the activation's cleanup once; binding
 * again first unbinds what is bound.
 */
export const bindAccount = (
  fixture: AccountFixture = {},
): FakeHost & { readonly unbind: () => void } => {
  unbindCurrent?.();
  const created = createFakeHost(fixture);
  const deactivate = activate({ services: created.services });

  const unbind = () => {
    if (unbindCurrent !== unbind) return;
    unbindCurrent = undefined;
    void deactivate();
  };
  unbindCurrent = unbind;
  return { ...created, unbind };
};

const noFixture: AccountFixture = {};

/**
 * Binds the account to a fake host built from `fixture`, then renders. Pass a
 * fixture defined once (module scope), not a literal built on every render.
 */
export function AccountHost({
  fixture = noFixture,
  children,
}: {
  readonly fixture?: AccountFixture;
  readonly children: ReactNode;
}) {
  const [host, setHost] = useState<FakeHost>();

  useLayoutEffect(() => {
    const bound = bindAccount(fixture);
    setHost(bound);
    return () => {
      setHost(undefined);
      bound.unbind();
    };
  }, [fixture]);

  return host === undefined ? null : children;
}
