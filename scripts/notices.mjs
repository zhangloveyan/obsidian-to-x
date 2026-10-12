import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function packageDirectory(input, root) {
  const parts = resolve(root, input).split(sep);
  const marker = parts.lastIndexOf('node_modules');
  if (marker < 0 || !parts[marker + 1]) return undefined;
  const packageEnd = marker + (parts[marker + 1].startsWith('@') ? 3 : 2);
  return parts.slice(0, packageEnd).join(sep);
}

function sourceUrl(manifest) {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (repository && /^(git\+)?https?:\/\//.test(repository)) {
    return repository.replace(/^git\+/, '').replace(/\.git$/, '');
  }
  return `https://www.npmjs.com/package/${manifest.name}`;
}

/** Include only package inputs that contribute bytes to the shipped JavaScript. */
export async function generateNotices({ root = projectRoot, metafilePath = join(root, 'work', 'build-meta.json'), outputPath = join(root, 'THIRD_PARTY_NOTICES.md') } = {}) {
  const metadata = JSON.parse(await readFile(metafilePath, 'utf8'));
  const bundle = Object.entries(metadata.outputs ?? {}).find(([output]) => resolve(root, output) === join(root, 'main.js'))?.[1];
  if (!bundle?.inputs) throw new Error('Build metadata has no main.js output. Run npm run build first.');
  const directories = new Set();
  for (const [input, details] of Object.entries(bundle.inputs)) {
    if (details.bytesInOutput <= 0) continue;
    const directory = packageDirectory(input, root);
    if (directory) directories.add(directory);
  }
  const packages = await Promise.all([...directories].map(async directory => {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (!manifest.name || !manifest.version) throw new Error('A bundled dependency is missing its name or version.');
    const names = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(name)).sort();
    if (!names.some(name => /^(licen[cs]e|copying)([.-].*)?$/i.test(name))) {
      throw new Error(`No license file found for bundled dependency ${manifest.name}@${manifest.version}.`);
    }
    const files = await Promise.all(names.map(async name => ({ name, text: (await readFile(join(directory, name), 'utf8')).trimEnd() })));
    return { manifest, files };
  }));
  packages.sort((left, right) => `${left.manifest.name}@${left.manifest.version}`.localeCompare(`${right.manifest.name}@${right.manifest.version}`, 'en'));
  const sections = [
    '# Third-party notices',
    '',
    'Generated from the esbuild inputs that contribute to main.js. The application is licensed under AGPL-3.0-only; the bundled components below retain their own licenses and copyright notices.',
    '',
    'The separately installed Playwright MCP, Chrome extension, Node.js and Obsidian are not redistributed in this bundle.',
  ];
  for (const { manifest, files } of packages) {
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'See license text';
    sections.push('', `## ${manifest.name} ${manifest.version}`, '', `License: ${license}`, '', `Source: ${sourceUrl(manifest)}`);
    for (const file of files) sections.push('', `### ${file.name}`, '', '```text', file.text, '```');
  }
  const text = `${sections.join('\n')}\n`;
  await writeFile(outputPath, text, 'utf8');
  return { text, count: packages.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (!value || !['--metafile', '--output'].includes(args[index])) throw new Error('Usage: node scripts/notices.mjs [--metafile path] [--output path]');
    options[args[index] === '--metafile' ? 'metafilePath' : 'outputPath'] = resolve(value);
  }
  const { count } = await generateNotices(options);
  console.log(`Third-party notices generated for ${count} bundled packages.`);
}
