// The identity of an artifact: a lowercase slug derived from its title plus a
// short random suffix (`checkout-7f3a`), which keeps the directory and the URL
// of the artifact readable and still unique without a registry.

import { randomBytes } from 'node:crypto';

/** The identity grammar: lowercase segments separated by single dashes. */
export const artifactIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The longest identity derived from a title; the suffix is added after it. */
const slugLimit = 48;

/** The slug of a title: lowercase, dashes, no accents and no punctuation. */
export const slugOf = (title: string): string => {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, slugLimit)
    .replace(/-+$/g, '');

  return slug === '' ? 'artifact' : slug;
};

/** Four hex characters, distinct enough to keep two artifacts apart. */
export const shortSuffix = (): string => randomBytes(2).toString('hex');

/** A fresh artifact identity derived from its title. */
export const newArtifactId = (title: string): string =>
  `${slugOf(title)}-${shortSuffix()}`;
