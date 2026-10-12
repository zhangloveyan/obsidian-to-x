import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import type { BrowserBridge } from '../src/model';
import type { PageAction } from '../src/browser/x-page';
import type { DraftSnapshot } from '../src/browser/x-protocol';

class Control {
  clicked = 0;
  width = 40;
  display = 'block';
  visibility = 'visible';
  icon = '';
  constructor(readonly tagName: 'BUTTON' | 'A', readonly textContent = '', readonly attributes: Record<string, string> = {}) {}
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  hasAttribute(name: string): boolean { return name in this.attributes; }
  getBoundingClientRect() { return { width: this.width, height: 32 }; }
  querySelectorAll(selector: string) {
    assert.equal(selector, 'svg path');
    return this.icon ? [{ getAttribute: (name: string) => name === 'd' ? this.icon : null }] : [];
  }
  click(): void { this.clicked++; }
}

const compiled = (async () => {
  const bundle = await build({ entryPoints: ['src/browser/x-page.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'es2022', minify: false, write: false, external: ['markdown-it'] });
  const module = { exports: {} as { runPage<T>(bridge: BrowserBridge, action: PageAction): Promise<T> } };
  runInContext(bundle.outputFiles[0]!.text, createContext({ module, require: createRequire(import.meta.url) }));
  return module.exports.runPage;
})();

async function create(controls: Control[], outside: Control[] = []) {
  const main = {
    querySelectorAll(selector: string) {
      assert.equal(selector, 'button,a[role="button"],a[data-testid="empty_state_button_text"]');
      return controls.filter(control => control.tagName === 'BUTTON' || control.getAttribute('role') === 'button' || control.getAttribute('data-testid') === 'empty_state_button_text');
    },
  };
  const context = createContext({
    location: { hostname: 'x.com', pathname: '/compose/articles' },
    document: {
      body: { querySelectorAll: () => [...controls, ...outside] },
      querySelector: (selector: string) => selector === 'main' ? main : null,
      querySelectorAll: (selector: string) => selector === 'a[href]' ? [...controls, ...outside].filter(control => control.tagName === 'A' && control.hasAttribute('href')) : [],
    },
    getComputedStyle: (control: Control) => ({ display: control.display, visibility: control.visibility }),
  });
  const bridge: BrowserBridge = {
    // Execute the emitted pageProgram.toString() through MCP 0.0.83's contract.
    async evaluate<T>(expression: string): Promise<T> {
      return await runInContext(`(async expr => { const value = eval('(' + expr + ')'); return await (typeof value === 'function' ? value() : value); })(${JSON.stringify(expression)})`, context) as T;
    },
    async call() { throw new Error('Unexpected browser tool'); },
    async close() { throw new Error('Unexpected close'); },
  };
  return (await compiled)<{ previous: string[] }>(bridge, { kind: 'create' });
}

const emptyLink = () => new Control('A', '撰写', { role: 'link', href: '/compose/articles', 'data-testid': 'empty_state_button_text' });

test('compiled page program prefers the native create button over the sidebar compose link', async () => {
  const button = new Control('BUTTON', '', { 'aria-label': 'create' });
  const link = emptyLink();
  const draft = new Control('A', 'Earlier draft', { href: '/compose/articles/edit/123' });
  const result = await create([button, link, draft]);
  assert.equal(button.clicked, 1);
  assert.equal(link.clicked, 0);
  assert.equal(draft.clicked, 0);
  assert.deepEqual([...result.previous], ['123']);
});

test('the empty-state link remains a fallback when no native create button is available', async () => {
  const link = emptyLink();
  await create([link]);
  assert.equal(link.clicked, 1);
});

test('multiple genuine native create buttons remain ambiguous even when a fallback link exists', async () => {
  const first = new Control('BUTTON', '', { 'aria-label': 'create' });
  const second = new Control('BUTTON', '创建');
  const link = emptyLink();
  await assert.rejects(() => create([first, second, link]), /找到 2 个新建文章入口/);
  assert.deepEqual([first.clicked, second.clicked, link.clicked], [0, 0, 0]);
});

test('hidden, disabled and existing-draft controls cannot displace a valid fallback', async () => {
  const hidden = new Control('BUTTON', '创建'); hidden.display = 'none';
  const invisible = new Control('BUTTON', '创建'); invisible.visibility = 'hidden';
  const zeroSize = new Control('BUTTON', '创建'); zeroSize.width = 0;
  const disabled = new Control('BUTTON', '创建', { disabled: '' });
  const ariaDisabled = new Control('BUTTON', '创建', { 'aria-disabled': 'true' });
  const draft = new Control('A', '创建', { role: 'button', href: '/compose/articles/edit/123' });
  const rejected = [hidden, invisible, zeroSize, disabled, ariaDisabled, draft];
  const link = emptyLink();
  await create([...rejected, link]);
  assert.equal(link.clicked, 1);
  assert.ok(rejected.every(control => control.clicked === 0));
  await assert.rejects(() => create(rejected), /未找到新建文章入口/);
});

test('known compose icon is supported while unrelated publish buttons and controls outside main are ignored', async () => {
  const iconButton = new Control('BUTTON'); iconButton.icon = 'M14.543 5.04297 fixture';
  const publish = new Control('BUTTON', 'Publish');
  const outsideCreate = new Control('BUTTON', 'Create');
  await create([iconButton, publish], [outsideCreate]);
  assert.equal(iconButton.clicked, 1);
  assert.equal(publish.clicked, 0);
  assert.equal(outsideCreate.clicked, 0);
  await assert.rejects(() => create([publish], [outsideCreate]), /未找到新建文章入口/);
});

test('multiple fallback links are rejected when there is no native create button', async () => {
  const first = emptyLink(), second = emptyLink();
  await assert.rejects(() => create([first, second]), /找到 2 个新建文章入口/);
  assert.deepEqual([first.clicked, second.clicked], [0, 0]);
});

function mediaPage() {
  const calls: Array<{ version: number; files: File[] }> = [];
  let focused = 0;
  let reject = false;
  let held = false;
  const location = { hostname: 'x.com', pathname: '/compose/articles/edit/123', href: 'https://x.com/compose/articles/edit/123' };
  const owner = (version: number) => ({
    editorState: { getCurrentContent: () => ({ getBlockMap: () => ({ toArray: () => [] }) }) },
    onFilesAdded(files: File[]) {
      calls.push({ version, files });
      if (reject) return Promise.reject(new Error('Native rejection after submission'));
      if (held) return new Promise<void>(() => {});
      return undefined;
    },
  });
  let current = owner(1);
  const editor = { focus: () => { focused++; }, __reactFiber$fixture: { stateNode: { get props() { return current; } }, return: { memoizedProps: { value: { store: { getState: () => ({ entities: { articleEntities: { entities: { '123': { title: '', media_entities: [] } } } } }) } } } } } };
  let mounted = true;
  const context = createContext({
    location, crypto: webcrypto, File, atob,
    document: {
      querySelector: () => mounted ? { closest: () => editor } : null,
      querySelectorAll: () => [],
    },
  });
  const bridge: BrowserBridge = {
    async evaluate<T>(expression: string): Promise<T> { return await runInContext(expression, context) as T; },
    async call() { throw new Error('Unexpected browser tool'); },
    async close() {},
  };
  return { bridge, calls, location, focused: () => focused, replace: () => { current = owner(2); }, disappear: () => { mounted = false; }, reject: () => { reject = true; }, hold: () => { held = true; } };
}

const uploadAction = (uploadId = 'upload-1'): PageAction => ({ kind: 'upload', id: '123', uploadId, asset: { name: 'photo.png', mime: 'image/png', base64: 'AQID' } });

test('compiled native upload submits bytes once per token and resolves the current callback after remount', async () => {
  const page = mediaPage(), run = await compiled;
  const before = await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123' });
  assert.ok(before.documentId);
  await run(page.bridge, uploadAction());
  await run(page.bridge, uploadAction());
  assert.equal(page.calls.length, 1);
  const file = page.calls[0]!.files[0]!;
  assert.equal(file.name, 'photo.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  page.replace();
  await run(page.bridge, uploadAction('upload-2'));
  assert.deepEqual(page.calls.map(call => call.version), [1, 2]);
  const after = await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123', uploadId: 'upload-2' });
  assert.equal(after.documentId, before.documentId);
  assert.equal(after.upload?.state, 'submitted');
  assert.equal((await run<DraftSnapshot>(mediaPage().bridge, { kind: 'read', id: '123' })).documentId === before.documentId, false);
});

test('native rejection remains observable without resubmitting and an unresolved callback does not block polling', async () => {
  const run = await compiled;
  for (const state of ['reject', 'hold'] as const) {
    const page = mediaPage(); page[state]();
    await run(page.bridge, uploadAction());
    const snapshot = await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123', uploadId: 'upload-1' });
    assert.equal(snapshot.upload?.state, state === 'reject' ? 'rejected' : 'submitted');
    await run(page.bridge, uploadAction());
    assert.equal(page.calls.length, 1);
    assert.equal((await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123', uploadId: 'unknown' })).upload?.state, 'missing');
  }
});

test('upload rejects navigation and absent editors before invoking the callback', async () => {
  const run = await compiled;
  const away = mediaPage(); away.location.pathname = '/home';
  await assert.rejects(run(away.bridge, uploadAction()), /离开本次草稿/);
  assert.equal(away.calls.length, 0);
  const missing = mediaPage(); missing.disappear();
  await assert.rejects(run(missing.bridge, uploadAction()), /尚未提供原生图片上传接口/);
  assert.equal(missing.calls.length, 0);
  assert.equal((await run<DraftSnapshot>(missing.bridge, { kind: 'read', id: '123', uploadId: 'upload-1' })).upload?.state, 'missing');
});

test('initial native focus requires the intended mounted editor and does not submit files', async () => {
  const page = mediaPage(), run = await compiled;
  await run(page.bridge, { kind: 'focus', id: '123' });
  assert.equal(page.focused(), 1);
  assert.equal(page.calls.length, 0);
  page.location.pathname = '/home';
  await assert.rejects(run(page.bridge, { kind: 'focus', id: '123' }), /离开本次草稿/);
  assert.equal(page.focused(), 1);
});
