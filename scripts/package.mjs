import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginId = 'markdown-x-publisher';
const files = ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const versions = JSON.parse(await readFile(join(root, 'versions.json'), 'utf8'));
if (manifest.id !== pluginId || manifest.version !== packageInfo.version || versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error('Manifest, package version and versions.json must agree before packaging.');
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.isDesktopOnly !== true) throw new Error('Invalid release manifest.');
const main = await readFile(join(root, 'main.js'), 'utf8');
const notices = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const license = await readFile(join(root, 'LICENSE'), 'utf8');
const comment = text => text.trimEnd().split(/\r?\n/).map(line => `// ${line}`).join('\n');
if (!main.includes(comment(notices)) || !main.includes(comment(license))) {
  throw new Error('main.js must contain the complete application and dependency licenses. Run npm run build again.');
}
const destination = join(root, 'dist', pluginId);
await mkdir(destination, { recursive: true });
const unexpected = (await readdir(destination)).filter(file => !files.includes(file));
if (unexpected.length) throw new Error(`Unexpected files in release directory: ${unexpected.join(', ')}. Review them before packaging.`);
for (const file of files) await copyFile(join(root, file), join(destination, file));
// Keep release metadata outside the installable plugin directory.
await writeFile(join(root, 'dist', 'release.json'), `${JSON.stringify({ id: pluginId, version: manifest.version, files }, null, 2)}\n`, 'utf8');
console.log(`Release files are ready in dist/${pluginId}/ (${manifest.version}).`);
