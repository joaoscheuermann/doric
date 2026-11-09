/**
 * The platform version `engines.doric` ranges are checked against and every
 * `doric.*` provider carries. It rises by a minor per phase that adds to the
 * platform (1.1.0: `desktop/ui/identity`, `desktop/ui/reader-avatar`).
 */
export const PLATFORM_VERSION = '1.1.0';

/**
 * The version segment of the platform folders and URLs (`desktop@<v>`,
 * `bundle@<v>`, `splash@<v>`, `shell@<v>`). It does not follow
 * `PLATFORM_VERSION`: a platform minor leaves every folder and URL where it was.
 */
export const PLATFORM_ASSETS_VERSION = '1.0.0';
