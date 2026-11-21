// The Claude sign-in as the settings window's provider page draws it, moved
// out of `settings` (bundle isolation 6(a)): `claude-login-field` is the item
// of `settings.provider.field` for the `claude` kind's `token` field. It is
// mounted alone here with the `view` settings sets on it and fake services
// (`claude.login/v1`, `doric.browser/v1`): no settings window and no settings
// part. A finished sign-in answers the page through the bubbling, composed
// DOM event `settings-provider-field`; the page writes the value into its
// draft. The messages the page's Alert carried move into the row (O2), keyed
// by `view.problem`, and the signed-in description names `view.label` (O1).

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  type CallArg,
  ContractError,
  type CredentialDescription,
} from 'bundle/contracts';

import type { ClaudeLoginFieldProps } from '../../src/client/claude-login-field.js';
import {
  installWindow,
  type MountedElement,
  mountElement,
  settle,
} from './support/render.js';
import { fakeServices } from './support/services.js';
import {
  explanationOf,
  noticesIn,
  type Toasts,
  titleOf,
  windowToasts,
} from './support/toasts.js';

/** The credential a sign-in answers: a Claude token, stored. */
const signedIn: CredentialDescription = {
  id: '00000000-0000-4000-8000-0000000000cc',
  kind: 'API_TOKEN',
  name: 'Claude',
  hasSecret: true,
};

/** The `view` settings sets on the element (`ProviderFieldView`). */
type ProviderFieldView = NonNullable<ClaudeLoginFieldProps['view']>;

/** The authorization page the host's `start` answers. */
const authorizeUrl = 'https://claude.com/cai/oauth/authorize?state=s';

/** The view settings sets on the item for an empty `claude` token. */
const emptyView: ProviderFieldView = { kind: 'claude', field: 'token' };

/**
 * The host behind `claude.login/v1` and the window's `doric.browser/v1`:
 * `finish` answers with `finish`, and records the calls it was given.
 */
const signInServices = (
  finish: (call: CallArg | undefined) => Promise<CredentialDescription>,
  options: { readonly browserFails?: boolean } = {},
) => {
  const opened: string[] = [];
  const finishes: (CallArg | undefined)[] = [];
  const { services } = fakeServices({
    'claude.login/v1': {
      start: async () => ({ url: authorizeUrl }),
      finish: (call?: CallArg) => {
        finishes.push(call);
        return finish(call);
      },
    },
    'doric.browser/v1': {
      open: async (url: string) => {
        opened.push(url);
        if (options.browserFails === true) {
          throw new ContractError('unavailable', 'No browser came up.');
        }
      },
    },
  });
  return { services, opened, finishes };
};

/** A `finish` that waits until its call's signal aborts, as the host does. */
const waitingFinish = (call: CallArg | undefined) =>
  new Promise<CredentialDescription>((_resolve, reject) => {
    const signal = (call as { readonly signal?: AbortSignal } | undefined)
      ?.signal;
    signal?.addEventListener('abort', () =>
      reject(
        new ContractError(
          'claude_login_aborted',
          'The Claude sign-in was cancelled.',
        ),
      ),
    );
  });

let mounted: MountedElement<ProviderFieldView> | undefined;
let toasts: Toasts | undefined;
let mounts = 0;

afterEach(async () => {
  mounted?.cleanup();
  mounted = undefined;
  toasts?.dismissAll();
  toasts = undefined;
  await settle(50);
});

/** Mounts `claude-login-field` alone with `view` over `services`. */
const mountField = async (
  services: ReturnType<typeof signInServices>['services'],
  view: ProviderFieldView = emptyView,
): Promise<MountedElement<ProviderFieldView>> => {
  installWindow();
  const { CLAUDE_LOGIN_FIELD_TAG, defineClaudeLoginField } = await import(
    '../../src/client/claude-login-field.js'
  );
  assert.equal(CLAUDE_LOGIN_FIELD_TAG, 'claude-login-field');
  toasts = await windowToasts();
  mounts += 1;
  mounted = await mountElement(
    `${CLAUDE_LOGIN_FIELD_TAG}-${mounts}`,
    defineClaudeLoginField(),
    { services, view },
  );
  return mounted;
};

const buttonOf = (
  root: ParentNode,
  label: string,
): HTMLButtonElement | undefined =>
  [...root.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;

const labelOf = (root: ParentNode): string | undefined =>
  root.querySelector('[data-slot="field-label"]')?.textContent?.trim() ??
  undefined;

/** The row's descriptions, in order. */
const descriptionsOf = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-slot="field-description"]')].map(
    (description) => description.textContent ?? '',
  );

/** The text of every toast drawn, one line each. */
const toastText = (): string =>
  [...document.querySelectorAll('[data-sonner-toast]')]
    .map((toast) => toast.textContent ?? '')
    .join('\n');

describe('the claude-login-field element, mounted alone', () => {
  test('an empty token offers the first sign-in under the label "Claude login"', async () => {
    const field = await mountField(
      signInServices(async () => signedIn).services,
    );

    assert.equal(labelOf(field.element), 'Claude login');
    const signIn = buttonOf(field.element, 'Sign in with Claude');
    assert.ok(signIn !== undefined, 'The sign-in button is missing.');
    assert.equal(signIn.disabled, false);
    // Asserted as a strict `undefined` check: a failed lookup answers a
    // happy-dom element, which a deep-equal would try to serialize whole.
    assert.ok(
      buttonOf(field.element, 'Cancel') === undefined,
      'An idle sign-in offers a cancel.',
    );
    const [description = ''] = descriptionsOf(field.element);
    assert.match(description, /browser/);
    assert.match(description, /stored|storage/);
  });

  test("a token the page names by its label offers a fresh sign-in and names the 'Claude' credential", async () => {
    const field = await mountField(
      signInServices(async () => signedIn).services,
      { ...emptyView, value: signedIn.id, label: 'Claude' },
    );

    assert.ok(
      buttonOf(field.element, 'Sign in again') !== undefined,
      'A signed-in provider offers no fresh sign-in.',
    );
    assert.match(
      descriptionsOf(field.element).join('\n'),
      /this provider uses the 'Claude' credential/,
    );
  });

  test('the page problem asks to sign in, or to sign in again for a credential no longer stored', async () => {
    const field = await mountField(
      signInServices(async () => signedIn).services,
      { ...emptyView, problem: 'missing' },
    );
    assert.match(
      field.element.textContent ?? '',
      /Sign in with Claude to finish this provider\./,
    );

    await field.setView({
      ...emptyView,
      value: '00000000-0000-4000-8000-0000000000ee',
      problem: 'unknown',
    });
    const text = field.element.textContent ?? '';
    assert.match(
      text,
      /The credential this provider names is no longer stored: sign in with Claude again\./,
    );
    assert.doesNotMatch(text, /Sign in with Claude to finish this provider\./);
    // A value nothing stored matches carries no label: the first sign-in again.
    assert.ok(
      buttonOf(field.element, 'Sign in with Claude') !== undefined,
      'The sign-in button is missing.',
    );

    await field.setView(emptyView);
    assert.doesNotMatch(
      field.element.textContent ?? '',
      /Sign in with Claude to finish|no longer stored/,
    );
  });

  test('a running sign-in opens the browser, shows the URL and waits until it is cancelled, silently', async () => {
    const host = signInServices(waitingFinish);
    const field = await mountField(host.services);

    buttonOf(field.element, 'Sign in with Claude')?.click();
    await settle();

    assert.deepEqual(host.opened, [authorizeUrl]);
    const waiting = buttonOf(field.element, 'Waiting for the browser…');
    assert.ok(
      waiting !== undefined,
      'The busy sign-in shows no waiting label.',
    );
    assert.equal(waiting.disabled, true);
    assert.match(
      descriptionsOf(field.element).join('\n'),
      /If the browser did not open, visit https:\/\/claude\.com\//,
    );
    assert.equal(host.finishes.length, 1);

    const cancel = buttonOf(field.element, 'Cancel');
    assert.ok(cancel !== undefined, 'A running sign-in offers no cancel.');
    cancel.click();
    await settle(50);

    const signal = (
      host.finishes[0] as { readonly signal?: AbortSignal } | undefined
    )?.signal;
    assert.equal(signal?.aborted, true, 'Cancelling did not abort finish.');
    assert.ok(
      buttonOf(field.element, 'Cancel') === undefined,
      'A cancelled sign-in keeps its cancel.',
    );
    const again = buttonOf(field.element, 'Sign in with Claude');
    assert.ok(again !== undefined, 'A cancelled sign-in stays busy.');
    assert.equal(again.disabled, false);
    assert.deepEqual(toasts?.surfaces(), [], 'A cancel toasts a failure.');
    assert.deepEqual(field.answers, []);
  });

  test('a browser that does not open leaves the sign-in waiting with its URL shown', async () => {
    const host = signInServices(waitingFinish, { browserFails: true });
    const field = await mountField(host.services);

    buttonOf(field.element, 'Sign in with Claude')?.click();
    await settle();

    assert.deepEqual(host.opened, [authorizeUrl]);
    assert.ok(
      buttonOf(field.element, 'Waiting for the browser…') !== undefined,
      'A browser that did not open ended the sign-in.',
    );
    assert.match(
      descriptionsOf(field.element).join('\n'),
      /If the browser did not open, visit https:\/\/claude\.com\//,
    );
    assert.equal(host.finishes.length, 1);
    assert.deepEqual(toasts?.surfaces(), []);
  });

  test('a finished sign-in answers the page once with the credential id, bubbling and composed, and toasts as claude-login', async () => {
    const field = await mountField(
      signInServices(async () => signedIn).services,
    );

    buttonOf(field.element, 'Sign in with Claude')?.click();
    await settle(50);

    assert.deepEqual(field.answers, [
      { value: signedIn.id, bubbles: true, composed: true },
    ]);
    assert.match(toastText(), /Claude is signed in\./);
    assert.ok(toasts?.ids().includes('claude-login'), 'no claude-login toast');
  });

  test('a sign-in that finishes after its element is disposed answers nothing, shows no success and toasts the info claude-login-finished (OD48)', async () => {
    const held: { release?: () => void } = {};
    // The host finishes when the test lets it, whatever became of the element.
    const field = await mountField(
      signInServices(
        () =>
          new Promise<CredentialDescription>((resolve) => {
            held.release = () => resolve(signedIn);
          }),
      ).services,
    );

    buttonOf(field.element, 'Sign in with Claude')?.click();
    await settle();
    const { release } = held;
    assert.ok(release !== undefined, 'The sign-in never waited on finish.');

    field.cleanup();
    await settle();
    release();
    await settle(50);

    assert.deepEqual(field.answers, [], 'A gone element answered the page.');
    assert.ok(
      !(toasts?.ids() ?? []).includes('claude-login'),
      'A sign-in nothing can use toasts a success.',
    );
    // The success check goes by id: the text of an earlier test's success
    // toast can still be in the shared toaster while it leaves.
    assert.ok(
      (toasts?.ids() ?? []).includes('claude-login-finished'),
      `no claude-login-finished toast: ${(toasts?.ids() ?? []).join(', ')}`,
    );
    assert.match(
      toastText(),
      /Claude sign-in finished after its page closed; sign in again from the provider page to use it/,
    );
    assert.deepEqual(toasts?.surfaces(), [], 'The info toasts a failure.');
  });

  test('a sign-in the authorization refuses toasts as claude-login-failed, titled "Sign-in failed" with its own message (T-38)', async () => {
    const field = await mountField(
      signInServices(async () => {
        throw new ContractError(
          'claude_login_failed',
          'The Claude sign-in failed: access_denied',
        );
      }).services,
    );

    buttonOf(field.element, 'Sign in with Claude')?.click();
    await settle(50);

    assert.ok(toasts?.ids().includes('claude-login-failed'));
    const surfaces = toasts?.surfaces() ?? [];
    assert.equal(surfaces.length, 1, 'one failure toast is drawn');
    const notice = noticesIn(surfaces[0])[0];
    assert.ok(notice, 'the toast holds no notice');
    assert.equal(titleOf(notice), 'Sign-in failed');
    assert.equal(
      explanationOf(notice),
      'The Claude sign-in failed: access_denied',
    );
    assert.deepEqual(field.answers, []);
    const again = buttonOf(field.element, 'Sign in with Claude');
    assert.ok(again !== undefined, 'A refused sign-in stays busy.');
    assert.equal(again.disabled, false);
  });

  test('a refused sign-in then a finished one leaves one toast, the plain "Claude is signed in." (T-39)', async () => {
    let refusing = true;
    const field = await mountField(
      signInServices(async () => {
        if (refusing) {
          throw new ContractError(
            'claude_login_failed',
            'The Claude sign-in failed: access_denied',
          );
        }
        return signedIn;
      }).services,
    );

    buttonOf(field.element, 'Sign in with Claude')?.click();
    await settle(50);
    assert.ok(toasts?.ids().includes('claude-login-failed'));

    refusing = false;
    buttonOf(field.element, 'Sign in with Claude')?.click();
    await settle(50);
    // Let a dismissed toast finish leaving.
    await settle(500);

    assert.ok(toasts?.ids().includes('claude-login'), 'no claude-login toast');
    assert.ok(
      !toasts?.ids().includes('claude-login-failed'),
      'claude-login-failed stays',
    );
    assert.deepEqual(toasts?.surfaces(), [], 'a failure toast stays drawn');
    const success = (toasts?.drawn() ?? []).filter((toast) =>
      /Claude is signed in\./.test(toast.textContent ?? ''),
    );
    assert.equal(success.length, 1, 'the success is not drawn once');
    assert.deepEqual(noticesIn(success[0]), [], 'the success draws a notice');
  });
});
