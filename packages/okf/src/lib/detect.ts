import path from 'node:path';

export const SUPPORTED_EXTENSIONS = [
  'ts',
  'mts',
  'cts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'json',
] as const;

export type SupportedType = (typeof SUPPORTED_EXTENSIONS)[number];

/** Derives the OKF type from the lowercase final filename extension. */
export const detectType = (source: string): string => {
  const extension = path.posix.extname(source.replaceAll('\\', '/'));

  return extension.length > 1
    ? extension.slice(1).toLowerCase()
    : 'no-extension';
};

export const isSupportedType = (type: string): type is SupportedType =>
  (SUPPORTED_EXTENSIONS as readonly string[]).includes(type);

export const isTypeScript = (type: SupportedType): boolean =>
  type === 'ts' || type === 'mts' || type === 'cts' || type === 'tsx';

export const hasModuleInterface = (type: SupportedType): boolean =>
  type !== 'json';
