import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(`${directory}/${entry.name}`)
    : [`${directory}/${entry.name}`]));
  return paths.flat();
}

const files = (await Promise.all(['src', 'api', 'public', 'scripts'].map(sourceFiles))).flat();
for (const path of files.filter(path => /\.(mjs|js)$/.test(path))) {
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const path of ['package.json', 'vercel.json']) JSON.parse(await readFile(path, 'utf8'));
for (const path of ['public/index.html', 'public/styles.css', 'public/app.js', 'README.md']) {
  if (!(await readFile(path, 'utf8')).trim()) throw new Error(`${path} is empty.`);
}
console.log('Build check passed. Vanilla JavaScript is served directly; no compilation is needed.');
