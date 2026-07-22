import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

const roots = ['apps', 'packages', 'tools'];
const sourceExtensions = new Set(['.css', '.js', '.jsx', '.py', '.ts', '.tsx']);
const maximumLines = 499;

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') return [];
        return collect(path);
      }
      const inSourceTree = path.split(sep).includes('src');
      return inSourceTree && sourceExtensions.has(extname(path)) ? [path] : [];
    }),
  );
  return nested.flat();
}

const files = (await Promise.all(roots.map(collect))).flat();
const violations = [];
for (const file of files) {
  const contents = await readFile(file, 'utf8');
  const lines = contents === '' ? 0 : contents.split(/\r?\n/u).length;
  if (lines > maximumLines) violations.push({ file: relative('.', file), lines });
}

if (violations.length) {
  for (const violation of violations.sort((left, right) => right.lines - left.lines)) {
    console.error(`${violation.file}: ${violation.lines} lines (maximum ${maximumLines})`);
  }
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} source files: all are under 500 lines.`);
}
