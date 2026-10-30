import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Remove only known build directories inside the project root.
const root = fileURLToPath(new URL('../', import.meta.url));
const requested = process.argv.slice(2);
for (const name of requested.length ? requested : ['dist', 'dist-test']) {
  if (!['dist', 'dist-test'].includes(name)) {
    throw new Error('Unknown build directory');
  }
  const target = path.resolve(root, name);
  if (path.dirname(target) !== path.resolve(root)) {
    throw new Error('Unsafe build path');
  }
  await fs.rm(target, { recursive: true, force: true });
}
