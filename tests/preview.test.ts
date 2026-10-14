import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { ParsedNote } from '../src/model';

interface NoteFile { path: string; basename: string; extension: string; }
interface Rendered { note: ParsedNote; path: string; }
interface ElementOptions { text?: string; cls?: string; attr?: Record<string, string>; }

class ElementStub {
  children: ElementStub[] = [];
  text = '';
  disabled = false;
  title = '';
  rendered: Rendered | undefined;
  private handlers = new Map<string, () => void>();
  constructor(public tag = 'div', public options: ElementOptions = {}) { this.text = options.text ?? ''; }
  createEl(tag: string, options?: ElementOptions): ElementStub {
    const child = new ElementStub(tag, options); this.children.push(child); return child;
  }
  createDiv(options?: ElementOptions): ElementStub { return this.createEl('div', options); }
  createSpan(options?: ElementOptions): ElementStub { return this.createEl('span', options); }
  addClass(_name: string): void { /* Layout does not affect event behavior. */ }
  empty(): void { this.children = []; this.text = ''; this.rendered = undefined; }
  setText(text: string): void { this.empty(); this.text = text; }
  addEventListener(name: string, callback: () => void): void { this.handlers.set(name, callback); }
  click(): void { if (!this.disabled) this.handlers.get('click')?.(); }
  find(predicate: (element: ElementStub) => boolean): ElementStub | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find(predicate); if (found) return found; }
    return undefined;
  }
}

class Events {
  private callbacks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  on(name: string, callback: (...args: unknown[]) => unknown): object {
    const callbacks = this.callbacks.get(name) ?? []; callbacks.push(callback); this.callbacks.set(name, callbacks); return {};
  }
  emit(name: string, ...args: unknown[]): void { for (const callback of this.callbacks.get(name) ?? []) callback(...args); }
}

class MarkdownViewStub {
  editor = { getValue: () => this.markdown };
  constructor(public file: NoteFile, public markdown: string) {}
}

interface LeafStub { app: object; view: unknown; setViewState?: (state: { type: string; active: boolean }) => Promise<void>; }

class ItemViewStub {
  contentEl = new ElementStub();
  app: object;
  constructor(leaf: LeafStub) { this.app = leaf.app; }
  registerEvent(_reference: object): void { /* Closed views are guarded even before host cleanup. */ }
}

const bundle = build({
  absWorkingDir: resolve('.'), entryPoints: ['src/ui/preview.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'preview-event-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ loader: 'js', contents: `
      export const ItemView = globalThis.host.ItemView;
      export const MarkdownView = globalThis.host.MarkdownView;
      export class Notice { constructor(message) { globalThis.notices.push(message); } }
      export const setIcon = () => {};
    ` }));
    builder.onLoad({ filter: /[\\/]ui[\\/]render-article\.ts$/ }, () => ({ loader: 'js', contents: `
      export function renderArticle(app, root, note, path) { root.empty(); root.rendered = {note,path}; globalThis.renders.push({note,path}); }
    ` }));
  } }],
});

async function harness() {
  const workspaceEvents = new Events();
  const vaultEvents = new Events();
  const renders: Rendered[] = [];
  const saves: NoteFile[] = [];
  const saveSources: Array<MarkdownViewStub | undefined> = [];
  const reads: string[] = [];
  const notices: string[] = [];
  const timers = new Map<number, () => void>();
  const disk = new Map<string, string | Promise<string>>();
  const leaves: LeafStub[] = [];
  let active: LeafStub | null = null;
  let recentFile: NoteFile | null = null;
  let timerId = 0;
  let opened = false;
  const states: Array<{ type: string; active: boolean }> = [];
  const app = {
    workspace: {
      on: workspaceEvents.on.bind(workspaceEvents),
      getActiveViewOfType: () => active?.view instanceof MarkdownViewStub ? active.view : null,
      getActiveFile: () => active?.view instanceof MarkdownViewStub ? active.view.file : recentFile,
      getLeavesOfType: (type: string) => leaves.filter(leaf => type === 'markdown' ? leaf.view instanceof MarkdownViewStub : leaf === previewLeaf),
      getRightLeaf: () => previewLeaf,
      revealLeaf: async (leaf: LeafStub) => { activate(leaf); },
    },
    vault: {
      on: vaultEvents.on.bind(vaultEvents),
      cachedRead: async (file: NoteFile) => { reads.push(file.path); return disk.get(file.path) ?? `Disk ${file.basename}`; },
    },
  };
  function activate(leaf: LeafStub | null): void {
    active = leaf;
    if (leaf?.view instanceof MarkdownViewStub) recentFile = leaf.view.file;
    workspaceEvents.emit('active-leaf-change', leaf);
  }
  const publisher = { app, settings: { autoPreview: true }, openDraft: async (file: NoteFile, source?: MarkdownViewStub) => { saves.push(file); saveSources.push(source); } };
  const context = createContext({
    module: { exports: {} }, require: createRequire(import.meta.url), console, renders, notices,
    host: { ItemView: ItemViewStub, MarkdownView: MarkdownViewStub },
    window: { setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => { timers.delete(id); } },
  });
  runInContext((await bundle).outputFiles[0]!.text, context);
  const previewLeaf: LeafStub = {
    app, view: null,
    async setViewState(state) {
      states.push(state);
      if (!opened) { opened = true; await preview.onOpen(); }
      if (state.active) activate(previewLeaf);
    },
  };
  const preview = new context.module.exports.ArticlePreview(previewLeaf, publisher);
  previewLeaf.view = preview;
  leaves.push(previewLeaf);
  const addEditor = (path: string, markdown: string) => {
    const file = { path, basename: path.split('/').pop()!.replace(/\.md$/, ''), extension: 'md' };
    const view = new MarkdownViewStub(file, markdown);
    const leaf = { app, view }; leaves.push(leaf); return { file, view, leaf };
  };
  const saveButton = () => (preview.contentEl as ElementStub).find(element => element.tag === 'button' && element.text === '保存草稿')!;
  const article = () => (preview.contentEl as ElementStub).find(element => element.options.cls === 'mxp-article markdown-rendered')!;
  return {
    preview, previewLeaf, publisher, renders, saves, saveSources, reads, disk, states, workspaceEvents, vaultEvents, addEditor, activate, saveButton, article,
    selectFileOnly: (file: NoteFile) => { active = null; recentFile = file; },
    flushTimers: () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
    timerCount: () => timers.size,
    openPreview: () => context.module.exports.openPreview(publisher),
  };
}

test('activating an already-open tab updates preview without file-open and saves that target', async () => {
  const h = await harness();
  const a = h.addEditor('a.md', '# A\n\nfirst unsaved');
  const b = h.addEditor('b.md', '# B\n\nsecond unsaved');
  h.activate(a.leaf);
  await h.preview.onOpen();
  assert.equal(h.renders.at(-1)?.note.title, 'A');
  h.activate(b.leaf);
  assert.equal(h.renders.at(-1)?.path, 'b.md');
  assert.equal(h.renders.at(-1)?.note.body.trim(), 'second unsaved');
  assert.equal(h.reads.length, 0);
  h.activate(h.previewLeaf);
  h.workspaceEvents.emit('file-open', null);
  assert.equal(h.renders.at(-1)?.path, 'b.md');
  h.saveButton().click();
  assert.equal(h.saves[0], b.file);
  assert.equal(h.saveSources[0], b.view);
});

test('same-file split panes use the last active editor, including while the preview has focus', async () => {
  const h = await harness();
  const stale = h.addEditor('same.md', '# Old buffer');
  const current = h.addEditor('same.md', '# Current buffer');
  h.activate(current.leaf);
  await h.preview.onOpen();
  assert.equal(h.renders.at(-1)?.note.title, 'Current buffer');
  h.activate(h.previewLeaf);
  current.view.markdown = '# Latest unsaved';
  h.workspaceEvents.emit('editor-change', current.view.editor, current.view);
  stale.view.markdown = '# Background stale';
  h.workspaceEvents.emit('editor-change', stale.view.editor, stale.view);
  assert.equal(h.timerCount(), 1);
  h.flushTimers();
  assert.equal(h.renders.at(-1)?.note.title, 'Latest unsaved');
  assert.equal(h.reads.length, 0);
  h.saveButton().click();
  assert.equal(h.saveSources[0], current.view);
});

test('auto refresh off still follows tab switches, while background edits cannot change the target', async () => {
  const h = await harness();
  const a = h.addEditor('a.md', '# A');
  const b = h.addEditor('b.md', '# B');
  h.activate(a.leaf);
  await h.preview.onOpen();
  h.publisher.settings.autoPreview = false;
  h.activate(b.leaf);
  assert.equal(h.renders.at(-1)?.note.title, 'B');
  a.view.markdown = '# Background';
  h.workspaceEvents.emit('editor-change', a.view.editor, a.view);
  h.vaultEvents.emit('modify', a.file);
  assert.equal(h.timerCount(), 0);
  assert.equal(h.renders.at(-1)?.path, 'b.md');
});

test('a slow previous disk read cannot overwrite a newly activated note or its save target', async () => {
  const h = await harness();
  const a = { path: 'a.md', basename: 'a', extension: 'md' };
  let resolveA!: (markdown: string) => void;
  h.disk.set(a.path, new Promise(resolve => { resolveA = resolve; }));
  h.selectFileOnly(a);
  const opening = h.preview.onOpen();
  assert.equal(h.saveButton().disabled, true);
  const b = h.addEditor('folder/b.md', '# B unsaved');
  h.activate(b.leaf);
  resolveA('# Delayed A');
  await opening;
  assert.equal(h.renders.at(-1)?.note.title, 'B unsaved');
  assert.equal(h.renders.at(-1)?.path, 'folder/b.md');
  assert.equal(h.renders.some(render => render.note.title === 'Delayed A'), false);
  h.saveButton().click();
  assert.equal(h.saves[0], b.file);
});

test('closing the preview invalidates pending reads and debounced editor refreshes', async () => {
  const h = await harness();
  const a = h.addEditor('a.md', '# A');
  h.activate(a.leaf);
  await h.preview.onOpen();
  h.workspaceEvents.emit('editor-change', a.view.editor, a.view);
  assert.equal(h.timerCount(), 1);
  let resolveDisk!: (markdown: string) => void;
  const diskFile = { path: 'disk.md', basename: 'disk', extension: 'md' };
  h.disk.set(diskFile.path, new Promise(resolve => { resolveDisk = resolve; }));
  const loading = h.preview.showFile(diskFile);
  const count = h.renders.length;
  await h.preview.onClose();
  resolveDisk('# Too late');
  await loading;
  h.activate(a.leaf);
  h.flushTimers();
  assert.equal(h.renders.length, count);
  assert.equal(h.timerCount(), 0);
});

test('read failures disable save instead of leaving the previous note available under a new target', async () => {
  const h = await harness();
  const a = h.addEditor('a.md', '# A');
  h.activate(a.leaf);
  await h.preview.onOpen();
  const missing = { path: 'missing.md', basename: 'missing', extension: 'md' };
  h.disk.set(missing.path, Promise.reject(new Error('missing file')));
  await h.preview.showFile(missing);
  assert.match(h.article().text, /预览失败.*missing file/);
  assert.equal(h.saveButton().disabled, true);
  h.saveButton().click();
  assert.equal(h.saves.length, 0);
});

test('image errors show literal source context without navigation and clear after editing', async () => {
  const h = await harness();
  const note = h.addEditor('文章.md', '# 标题\n\n1. 打开 **预览**\n\n   ![截图](preview.png)\n\n2. 保存草稿');
  h.activate(note.leaf);
  await h.preview.onOpen();
  const panel = h.article().find(element => element.options.cls === 'mxp-preview-error')!;
  assert.ok(panel);
  assert.equal(panel.find(element => element.options.cls === 'mxp-error-location')?.text, '原文第 5 行 · 编号列表');
  assert.ok(panel.find(element => element.text === '1. 打开 **预览**'));
  assert.ok(panel.find(element => element.text === '   ![截图](preview.png)'));
  assert.equal(panel.find(element => element.tag === 'button' || element.tag === 'img'), undefined);
  assert.equal(h.saveButton().disabled, true);
  h.saveButton().click();
  assert.equal(h.saves.length, 0);
  note.view.markdown = '<img src="local.png" onerror="alert(1)">';
  h.workspaceEvents.emit('editor-change', note.view.editor, note.view);
  h.flushTimers();
  assert.ok(h.article().find(element => element.text === note.view.markdown));
  assert.equal(h.article().find(element => element.tag === 'img'), undefined);
  note.view.markdown = '# 标题\n\n普通正文';
  h.workspaceEvents.emit('editor-change', note.view.editor, note.view);
  h.flushTimers();
  assert.equal(h.article().find(element => element.options.cls === 'mxp-preview-error'), undefined);
  assert.equal(h.saveButton().disabled, false);
  assert.equal(h.renders.at(-1)?.note.title, '标题');
});

test('opening the preview captures the current unsaved editor before moving focus into its panel', async () => {
  const h = await harness();
  h.addEditor('same.md', '# Stale first pane');
  const current = h.addEditor('same.md', '# Selected unsaved pane');
  h.activate(current.leaf);
  await h.openPreview();
  assert.equal(h.states[0]?.active, false);
  assert.equal(h.renders.at(-1)?.note.title, 'Selected unsaved pane');
  h.saveButton().click();
  assert.equal(h.saves[0], current.file);
  assert.equal(h.saveSources[0], current.view);
});

test('same-leaf file-open follows its new Markdown file and ignores stale events for a previous file', async () => {
  const h = await harness();
  const a = h.addEditor('a.md', '# A');
  const previousFile = a.file;
  h.activate(a.leaf);
  await h.preview.onOpen();
  const nextFile = { path: 'b.md', basename: 'b', extension: 'md' };
  a.view.file = nextFile;
  a.view.markdown = '# Same leaf B';
  h.workspaceEvents.emit('file-open', nextFile);
  h.workspaceEvents.emit('file-open', previousFile);
  assert.equal(h.renders.at(-1)?.path, 'b.md');
  assert.equal(h.renders.at(-1)?.note.title, 'Same leaf B');
  h.saveButton().click();
  assert.equal(h.saves[0], nextFile);
});

test('a tab switch while the preview panel is opening wins over the originally active note', async () => {
  const h = await harness();
  const a = h.addEditor('a.md', '# A');
  const b = h.addEditor('b.md', '# B');
  h.activate(a.leaf);
  const setViewState = h.previewLeaf.setViewState!;
  h.previewLeaf.setViewState = async state => { await setViewState(state); h.activate(b.leaf); };
  await h.openPreview();
  assert.equal(h.renders.at(-1)?.path, 'b.md');
  h.saveButton().click();
  assert.equal(h.saves[0], b.file);
  assert.equal(h.saveSources[0], b.view);
});
