import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { ParsedNote } from '../src/model';

async function pluginHarness(closeFails = false) {
  const secrets = new Map<string, string>();
  const calls: Array<{ name: string; source?: string; request?: unknown; bridgeId?: number }> = [];
  const control = {
    token: 'test-token', probeFailures: 0, saveFails: false, resumableFailure: false,
    connectGate: null as Promise<void> | null, connectStarted: () => {},
    imageGate: null as Promise<void> | null, imageStarted: () => {}
  };
  const bundle = await build({
    entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'obsidian-host', setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
      builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ loader: 'js', contents: `
        export class Plugin {} export class Modal {} export class ItemView {} export class PluginSettingTab {}
        export class Component {} export class FuzzySuggestModal {} export class TFile {}
        export class MarkdownView { constructor(file, text) { this.file=file; this.editor={getValue:()=>text}; } }
        globalThis.MockMarkdownView = MarkdownView;
        export class Notice {} export class Setting {} export class SecretComponent {}
        export const Platform = { isWin: true, isMacOS: false };
        export const MarkdownRenderer = {}; export const addIcon = () => {}; export const setIcon = () => {}; export const requestUrl = () => {}; export const sanitizeHTMLToDom = () => {};
      ` }));
      builder.onLoad({ filter: /[\\/]ui[\\/]draft-modal\.ts$/ }, () => ({ loader: 'js', contents: `
        export class DraftModal { constructor(plugin, file, note) { globalThis.calls.push({name:'modal',request:note}); } open() {} }
      ` }));
      builder.onLoad({ filter: /[\\/]browser[\\/]runtime\.ts$/ }, () => ({ loader: 'js', contents: `
        let nextId = 0;
        export const normalizeToken = value => value.trim();
        export async function connectBrowser(settings, diagnostic) {
          const bridgeId = ++nextId;
          globalThis.calls.push({name:'connect',bridgeId});
          globalThis.control.connectStarted();
          if(globalThis.control.connectGate) await globalThis.control.connectGate;
          return {
            async call(name,args) {
              if(name !== 'browser_tabs' || args.action !== 'list') throw new Error('Expected read-only tab probe');
              globalThis.calls.push({name:'probe',bridgeId});
              diagnostic('mcp.tool.completed',{tool:name,durationMs:1});
              if(globalThis.control.probeFailures > 0) { globalThis.control.probeFailures--; throw new Error('stale connection'); }
              return {content:[]};
            },
            async close() { globalThis.calls.push({name:'close',bridgeId}); if(globalThis.closeFails) throw new Error('close failed'); }
          };
        }
      ` }));
      builder.onLoad({ filter: /[\\/]browser[\\/]x-draft\.ts$/ }, () => ({ loader: 'js', contents: `
        export async function saveDraft(bridge, request, progress, diagnostic, session) {
          globalThis.calls.push({name:'save',request});
          if(globalThis.control.resumableFailure) { session.resumable=true; throw new Error('retry current draft'); }
          if(globalThis.control.saveFails) throw new Error('upload failed');
          progress('saved'); return {id:'test',url:'https://x.com/compose/articles/edit/test'};
        }
      ` }));
      builder.onLoad({ filter: /[\\/]assets\.ts$/ }, () => ({ loader: 'js', contents: `
        export function resolveImage() {return null;}
        export async function loadImage(app,source,notePath) {
          globalThis.calls.push({name:'image',source});
          globalThis.control.imageStarted();
          if(globalThis.control.imageGate) await globalThis.control.imageGate;
          return {source,name:source,mime:'image/png',base64:'fixture'};
        }
      ` }));
    } }], absWorkingDir: resolve('.')
  });
  const context = createContext({ module: { exports: {} }, require: createRequire(import.meta.url), calls, control, closeFails, console, setTimeout, clearTimeout, TextEncoder });
  runInContext(bundle.outputFiles[0]!.text, context);
  const Instance = context.module.exports.default;
  const instance = new Instance();
  instance.app = { vault: { configDir: '.obsidian' }, secretStorage: { getSecret: (name: string) => secrets.get(name) ?? (name === 'secret' ? control.token : null), setSecret: (name: string, value: string) => { secrets.set(name, value); } } };
  instance.settings = { nodePath: '', mcpPath: 'test-cli.js', secretName: 'secret', autoPreview: true };
  instance.saveData = async () => {};
  return { instance, calls, control, secrets, MarkdownView: context.MockMarkdownView };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const note: ParsedNote = {
  title: 'Reviewed title', body: '',
  blocks: [
    { type: 'text', kind: 'unstyled', text: 'Reviewed body', styles: [], links: [] },
    { type: 'image', source: 'a.png', alt: 'first' },
    { type: 'image', source: 'a.png', alt: 'repeated' }
  ]
};

test('reviewed note is passed once without an automatic cover; successful drafts retain the connection and unload cleanup cannot change success', async () => {
  const { instance, calls } = await pluginHarness(true);
  const result = await instance.saveDraft({ path: 'selected.md' }, note, () => {});
  assert.equal(result.id, 'test');
  assert.equal(instance.busy, false);
  assert.equal(calls.filter(call => call.name === 'image').length, 1);
  const request = calls.find(call => call.name === 'save')!.request as { title: string; blocks: unknown[]; images: unknown[]; cover?: unknown };
  assert.equal(request.title, note.title);
  assert.equal(request.blocks, note.blocks);
  assert.equal(request.images.length, 1);
  assert.equal(request.cover, undefined);
  assert.equal(calls.filter(call => call.name === 'close').length, 0);
  await instance.saveDraft({ path: 'selected.md' }, note, () => {});
  assert.equal(calls.filter(call => call.name === 'connect').length, 1);
  assert.equal(calls.filter(call => call.name === 'save').length, 2);
  assert.equal(calls.filter(call => call.name === 'close').length, 0);
  instance.onunload();
  assert.equal(calls.filter(call => call.name === 'close').length, 1);
  assert.equal(result.id, 'test');
});

test('connection testing and saving share a bridge and probe it on every operation', async () => {
  const { instance, calls } = await pluginHarness();
  assert.match(await instance.testConnection(), /已连接/);
  await instance.saveDraft({ path: 'selected.md' }, note, () => {});
  await instance.testConnection();
  assert.equal(calls.filter(call => call.name === 'connect').length, 1);
  assert.equal(calls.filter(call => call.name === 'probe').length, 3);
  assert.equal(calls.filter(call => call.name === 'close').length, 0);
  assert.match(instance.diagnostics.text(), /mcp\.tool\.completed/);
});

test('only runtime settings and actual secret changes release a retained connection', async () => {
  const { instance, calls, control } = await pluginHarness();
  await instance.testConnection();
  instance.settings.autoPreview = false;
  await instance.saveSettings();
  assert.equal(calls.filter(call => call.name === 'close').length, 0);
  for (const key of ['nodePath', 'mcpPath']) {
    instance.settings[key] = 'changed-runtime-path';
    await instance.saveSettings();
    assert.equal(calls.at(-1)?.name, 'close');
    await instance.testConnection();
  }
  // SecretStorage may replace the value without changing the configured secret name.
  control.token = 'replacement-token';
  await instance.testConnection();
  assert.equal(calls.filter(call => call.name === 'connect').length, 4);
  assert.equal(calls.filter(call => call.name === 'close').length, 3);
  assert.doesNotMatch(instance.diagnostics.text(), /test-token|replacement-token|changed-runtime-path/);
});

test('a stale retained connection reconnects once before saving, without replaying the article', async () => {
  const { instance, calls, control } = await pluginHarness();
  await instance.testConnection();
  control.probeFailures = 1;
  await instance.saveDraft({ path: 'selected.md' }, note, () => {});
  assert.equal(calls.filter(call => call.name === 'connect').length, 2);
  assert.equal(calls.filter(call => call.name === 'close').length, 1);
  assert.equal(calls.filter(call => call.name === 'save').length, 1);
  // A failed fresh probe ends the attempt, even if the previous bridge was also stale.
  control.probeFailures = 2;
  await assert.rejects(() => instance.testConnection(), /stale connection/);
  assert.equal(calls.filter(call => call.name === 'connect').length, 3);
  assert.equal(calls.filter(call => call.name === 'close').length, 3);
});

test('save failure releases the connection once and retains the original error despite cleanup failure', async () => {
  const { instance, calls, control } = await pluginHarness(true);
  control.saveFails = true;
  await assert.rejects(() => instance.saveDraft({ path: 'selected.md' }, note, () => {}), /upload failed/);
  assert.equal(instance.busy, false);
  assert.equal(calls.filter(call => call.name === 'connect').length, 1);
  assert.equal(calls.filter(call => call.name === 'save').length, 1);
  assert.equal(calls.filter(call => call.name === 'close').length, 1);
  control.saveFails = false;
  await instance.testConnection();
  assert.equal(calls.filter(call => call.name === 'connect').length, 2);
});

test('a resumable image failure retains the same browser connection for continuing', async () => {
  const { instance, calls, control } = await pluginHarness();
  const session: { resumable?: boolean } = {};
  control.resumableFailure = true;
  await assert.rejects(() => instance.saveDraft({ path: 'selected.md' }, note, () => {}, undefined, session), /retry current draft/);
  assert.equal(session.resumable, true);
  assert.equal(instance.busy, false);
  assert.equal(calls.filter(call => call.name === 'close').length, 0);
  control.resumableFailure = false;
  await instance.saveDraft({ path: 'selected.md' }, note, () => {}, undefined, session);
  assert.equal(calls.filter(call => call.name === 'connect').length, 1);
  instance.onunload();
  assert.equal(calls.filter(call => call.name === 'close').length, 1);
});

test('missing setup and concurrent saves do not start a browser or upload anything', async () => {
  const { instance, calls } = await pluginHarness();
  instance.app.secretStorage.getSecret = () => '';
  await assert.rejects(() => instance.saveDraft({ path: 'selected.md' }, note, () => {}), /配置/);
  assert.equal(instance.busy, false);
  instance.busy = true;
  await assert.rejects(() => instance.saveDraft({ path: 'selected.md' }, note, () => {}), /已有文章/);
  assert.equal(calls.length, 0);
});

test('empty runtime paths use discovery and an explicitly chosen local cover is not read from the vault', async () => {
  const { instance, calls } = await pluginHarness();
  instance.settings.nodePath = '';
  instance.settings.mcpPath = '';
  const cover = { source: 'selected-local-cover', name: 'cover.png', mime: 'image/png', base64: 'chosen-by-user' };
  await instance.saveDraft({ path: 'selected.md' }, note, () => {}, cover);
  const request = calls.find(call => call.name === 'save')!.request as { cover: unknown };
  assert.equal(request.cover, cover);
  assert.equal(calls.filter(call => call.name === 'image').length, 1);
  assert.ok(calls.some(call => call.name === 'connect'));
});

test('unloaded plugin never reads images or starts a browser', async () => {
  const { instance, calls } = await pluginHarness();
  instance.onunload();
  await assert.rejects(() => instance.saveDraft({ path: 'selected.md' }, note, () => {}), /停用/);
  await assert.rejects(() => instance.testConnection(), /停用/);
  assert.equal(calls.length, 0);
  assert.equal(instance.busy, false);
});

test('unloading during image preparation never starts a connection', async () => {
  const { instance, calls, control } = await pluginHarness();
  const gate = deferred();
  const started = deferred();
  control.imageGate = gate.promise;
  control.imageStarted = started.resolve;
  const saving = instance.saveDraft({ path: 'selected.md' }, note, () => {});
  await started.promise;
  instance.onunload();
  gate.resolve();
  await assert.rejects(saving, /停用/);
  assert.equal(calls.filter(call => call.name === 'connect').length, 0);
});

test('unloading or changing settings while a connection is loading closes its late result without uploading', async () => {
  for (const change of ['unload', 'settings']) {
    const { instance, calls, control } = await pluginHarness();
    const gate = deferred();
    const started = deferred();
    control.connectGate = gate.promise;
    control.connectStarted = started.resolve;
    const saving = instance.saveDraft({ path: 'selected.md' }, note, () => {});
    await started.promise;
    if (change === 'unload') instance.onunload();
    else { control.token = 'new-token'; await instance.saveSettings(); }
    gate.resolve();
    await assert.rejects(saving, /停用|设置已更改/);
    assert.equal(calls.filter(call => call.name === 'close').length, 1);
    assert.equal(calls.filter(call => call.name === 'save').length, 0);
    if (change === 'unload') await assert.rejects(() => instance.testConnection(), /停用/);
    assert.equal(calls.filter(call => call.name === 'connect').length, 1);
  }
});

test('unloading while plugin data loads prevents late UI registration', async () => {
  const { instance } = await pluginHarness();
  const gate = deferred();
  const started = deferred();
  instance.loadData = async () => { started.resolve(); await gate.promise; return null; };
  instance.addSettingTab = () => assert.fail('Plugin must not register UI after unloading');
  const loading = instance.onload();
  await started.promise;
  instance.onunload();
  gate.resolve();
  await loading;
});

test('draft confirmation uses the preview editor buffer and ignores a source view that has since closed', async () => {
  const { instance, calls, MarkdownView } = await pluginHarness();
  const file = { path: 'same-note.md', basename: 'same-note' };
  const first = new MarkdownView(file, '# First editor\n\nOlder text.');
  const previewSource = new MarkdownView(file, '# Reviewed editor\n\nLatest unsaved text.');
  let leaves = [{ view: first }, { view: previewSource }];
  instance.app.workspace = { getLeavesOfType: () => leaves, getActiveViewOfType: () => first };
  await instance.openDraft(file, previewSource);
  const reviewed = calls.at(-1)?.request as ParsedNote;
  assert.equal(reviewed.title, 'Reviewed editor');
  assert.match(reviewed.body, /Latest unsaved text/);
  leaves = [{ view: first }];
  await instance.openDraft(file, previewSource);
  assert.equal((calls.at(-1)?.request as ParsedNote).title, 'First editor');
});

test('runtime paths become active together only after persistence succeeds; failed writes retain the connection', async () => {
  const { instance, calls } = await pluginHarness();
  await instance.testConnection();
  const original = { ...instance.settings };
  const gate = deferred();
  const started = deferred();
  let persisted: unknown;
  instance.saveData = async (value: unknown) => { persisted = value; started.resolve(); await gate.promise; };
  const saving = instance.saveRuntimePaths({ nodePath: 'node-directory', mcpPath: 'mcp-directory' });
  await started.promise;
  assert.equal(instance.busy, true);
  assert.deepEqual(instance.settings, original);
  assert.equal(calls.filter(call => call.name === 'close').length, 0);
  await assert.rejects(instance.testConnection(), /请稍候/);
  gate.resolve(); await saving;
  assert.equal(instance.settings.nodePath, 'node-directory');
  assert.equal(instance.settings.mcpPath, 'mcp-directory');
  assert.equal(instance.settings, persisted);
  assert.equal(calls.filter(call => call.name === 'close').length, 1);
  await instance.testConnection();
  const saved = instance.settings;
  instance.saveData = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(instance.saveRuntimePaths({ nodePath: 'other-node', mcpPath: 'other-mcp' }), /disk unavailable/);
  assert.equal(instance.settings, saved);
  assert.equal(instance.busy, false);
  assert.equal(calls.filter(call => call.name === 'close').length, 1);
});

test('single-key editing preserves a legacy shared credential and never writes token values to plugin preferences', async () => {
  const { instance, secrets, calls } = await pluginHarness();
  await instance.testConnection();
  assert.equal(instance.connectionSettings().token, 'test-token');
  let persisted: unknown;
  instance.saveData = async (value: unknown) => { persisted = value; };
  await instance.saveConnectionToken(' new-private-token ');
  assert.equal(instance.connectionSettings().token, 'new-private-token');
  assert.equal(instance.app.secretStorage.getSecret('secret'), 'test-token');
  assert.equal(secrets.get(instance.settings.secretName), 'new-private-token');
  assert.doesNotMatch(JSON.stringify(persisted), /new-private-token|test-token/);
  assert.equal(calls.filter(call => call.name === 'close').length, 1);
  await instance.testConnection();
  const previous = instance.settings;
  instance.saveData = async () => { throw new Error('failed write containing new-value'); };
  await assert.rejects(instance.saveConnectionToken('new-value'), error => {
    assert.match(String(error), /密钥未能保存/);
    assert.doesNotMatch(String(error), /new-value/);
    return true;
  });
  assert.equal(instance.settings, previous);
  assert.equal(instance.connectionSettings().token, 'new-private-token');
  assert.equal(calls.filter(call => call.name === 'close').length, 1);
});

test('preview preference persistence is serialized with runtime and credential changes', async () => {
  const { instance } = await pluginHarness();
  const gate = deferred(), started = deferred();
  instance.saveData = async () => { started.resolve(); await gate.promise; };
  const saving = instance.saveAutoPreview(false);
  await started.promise;
  assert.equal(instance.settings.autoPreview, true);
  await assert.rejects(instance.saveRuntimePaths({ nodePath: 'node', mcpPath: 'mcp' }), /完成后/);
  await assert.rejects(instance.saveConnectionToken('replacement'), /完成后/);
  gate.resolve(); await saving;
  assert.equal(instance.settings.autoPreview, false);
  instance.saveData = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(instance.saveAutoPreview(true), /disk unavailable/);
  assert.equal(instance.settings.autoPreview, false);
  assert.equal(instance.busy, false);
});
