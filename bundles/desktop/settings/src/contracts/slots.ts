/** The settings window's navigation: items are `settings-link` elements, one per section; drawn by `settings`. */
export const SETTINGS_SECTIONS = 'settings.sections';

/**
 * The provider page's field slot: an item replaces one field of the provider
 * form for one kind. Items are elements with `ProviderFieldItemProps`; drawn by
 * `settings`, which sets `view` on the element and takes its answer from the
 * bubbling, composed DOM event `settings-provider-field`
 * (`CustomEvent<{ value: string }>`). With two items for one kind and field the
 * first by `order` is drawn; with none, `settings` draws the field itself.
 */
export const SETTINGS_PROVIDER_FIELD = 'settings.provider.field';

/** The `props` of an item of `settings.provider.field`. */
export interface ProviderFieldItemProps {
  /** The provider kind whose form the item is drawn in. */
  readonly kind: string;
  /** The key of the kind's field the element is drawn in place of. */
  readonly field: string;
}

/** The `view` property `settings` sets on the item's element. */
export interface ProviderFieldView {
  readonly kind: string;
  readonly field: string;
  /** The field's value in the draft: for a secret field, a credential id. */
  readonly value?: string;
  /** The name of what `value` names: for a secret field, the stored credential's name. Absent when nothing stored matches. (O1) */
  readonly label?: string;
  /** `missing`: the field is required and empty. `unknown`: the value names a credential the store no longer has. */
  readonly problem?: 'missing' | 'unknown';
}
