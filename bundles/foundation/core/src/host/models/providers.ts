/** One configured provider, as the Doric configuration carries it. */
export interface ConfiguredProvider {
  readonly id: string;
  readonly kind: string;
  /** The kind's own values; a `secret` field's value is a credential id. */
  readonly configuration: Readonly<Record<string, string>>;
  /** The model names the configuration lists for it, when it lists any. */
  readonly models?: readonly string[];
}
