// Bundles the action into dist/index.js and writes the licenses of the bundled packages
// to dist/licenses.txt. Run with `npm run build`; dist/ is committed.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.js'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Bundled CommonJS code calls require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

/** @param {string} input a metafile input path */
function packageDir(input) {
  const parts = input.split('/');
  const index = parts.lastIndexOf('node_modules');
  if (index === -1) return undefined;
  const name = parts[index + 1]?.startsWith('@')
    ? parts.slice(index + 1, index + 3)
    : parts.slice(index + 1, index + 2);
  return path.join(root, ...parts.slice(0, index + 1), ...name);
}

const dirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const dir = packageDir(input);
  if (dir) dirs.add(dir);
}

const sections = [];
for (const dir of dirs) {
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const licenseFile = (await readdir(dir)).find((file) => /^licen[cs]e(\.(md|txt))?$/i.test(file));
  const text = licenseFile ? (await readFile(path.join(dir, licenseFile), 'utf8')).trim() : '';
  sections.push({
    name: pkg.name,
    body: `${pkg.name}@${pkg.version}\n${pkg.license ?? 'UNKNOWN'}\n${text}`,
  });
}
sections.sort((a, b) => a.name.localeCompare(b.name));
await writeFile(path.join(root, 'dist', 'licenses.txt'), `${sections.map((section) => section.body).join('\n\n')}\n`);

const bytes = result.metafile.outputs['dist/index.js']?.bytes ?? 0;
console.log(`dist/index.js: ${(bytes / 1024).toFixed(0)} KiB from ${dirs.size} packages`);
