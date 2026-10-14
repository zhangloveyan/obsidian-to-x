import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { detectChromeExtension, PLAYWRIGHT_EXTENSION_ID } from '../src/browser/extension';

async function chromeFixture(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'markdown-x-publisher-extension-'));
  context.after(async () => {
    assert.equal(dirname(root), tmpdir());
    assert.ok(basename(root).startsWith('markdown-x-publisher-extension-'));
    await rm(root, { recursive: true });
  });
  return root;
}

async function installFixture(root: string, profile: string, id = PLAYWRIGHT_EXTENSION_ID, contents = JSON.stringify({ manifest_version: 3, version: '0.0.89' })): Promise<string> {
  const extension = join(root, profile, 'Extensions', id, '0.0.89_0');
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, 'manifest.json'), contents);
  return extension;
}

test('extension installation in another Chrome profile is found without reading browser preferences', async context => {
  const root = await chromeFixture(context);
  await mkdir(join(root, 'Default'));
  const extension = await installFixture(root, 'Profile 3');
  await writeFile(join(root, 'Profile 3', 'Preferences'), 'not valid JSON; must not be read');
  assert.deepEqual(await detectChromeExtension([root]), { found: true, path: extension, profile: 'Profile 3', version: '0.0.89' });
});

test('unrelated extensions and empty or malformed official extension directories do not count as found', async context => {
  const root = await chromeFixture(context);
  await installFixture(root, 'Default', 'abcdefghijklmnopabcdefghijklmnop');
  assert.deepEqual(await detectChromeExtension([root]), { found: false });
  const extension = await installFixture(root, 'Profile 1', PLAYWRIGHT_EXTENSION_ID, 'invalid json');
  assert.deepEqual(await detectChromeExtension([root]), { found: false });
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({ name: 'unrelated file' }));
  assert.deepEqual(await detectChromeExtension([root]), { found: false });
});

test('a missing or wrong user-data folder reports not found without searching unrelated files', async context => {
  const root = await chromeFixture(context);
  const extension = await installFixture(root, 'Default');
  assert.deepEqual(await detectChromeExtension([join(root, 'missing'), extension, 'relative/path']), { found: false });
  assert.deepEqual(await detectChromeExtension([]), { found: false });
});

test('a later Chrome user-data directory is searched when an earlier one is unavailable', async context => {
  const root = await chromeFixture(context);
  const extension = await installFixture(root, 'Default');
  const detected = await detectChromeExtension([join(root, 'missing'), root]);
  assert.equal(detected.found, true);
  assert.equal(detected.path, extension);
});
