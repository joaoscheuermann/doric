// Writes src/styles/tokens.css and dist/tokens.json from src/tokens/tokens.ts,
// through the module `tsc --build` emitted into dist/. Run by `desktop/ui:build`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { tokens } = await import(join(root, 'dist/tokens/tokens.js'));
const { tokensCss } = await import(join(root, 'dist/tokens/css.js'));

writeFileSync(join(root, 'src/styles/tokens.css'), tokensCss(tokens));
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(
  join(root, 'dist/tokens.json'),
  `${JSON.stringify(tokens, null, 2)}\n`,
);
