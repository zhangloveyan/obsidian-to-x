import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import type { BrowserBridge } from '../src/model';
import type { PageAction } from '../src/browser/x-page';
import type { DraftSnapshot } from '../src/browser/x-protocol';

const compiled = (async () => {
  const bundle = await build({ entryPoints: ['src/browser/x-page.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'es2022', minify: false, write: false, external: ['markdown-it'] });
  const module = { exports: {} as { runPage<T>(bridge: BrowserBridge, action: PageAction): Promise<T> } };
  runInContext(bundle.outputFiles[0]!.text, createContext({ module, require: createRequire(import.meta.url) }));
  return module.exports.runPage;
})();

class Element {
  parentElement: Element | null = null;
  children: Element[] = [];
  disabled = false;
  value = '';
  accept = '';
  clicked = 0;
  focused = 0;
  assignments = 0;
  events: Event[] = [];
  onClick?: () => void;
  onEvent?: (event: Event) => void;
  private selectedFiles: File[] = [];
  constructor(readonly tagName: string, readonly attributes: Record<string, string> = {}, readonly textContent = '') {}
  get files(): File[] { return this.selectedFiles; }
  set files(value: File[]) { this.selectedFiles = value; this.assignments++; }
  get isConnected(): boolean { return this.tagName === '#document' || (this.parentElement?.isConnected ?? false); }
  get nextElementSibling(): Element | null {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  append(...elements: Element[]): void {
    for (const element of elements) {
      element.remove();
      this.children.push(element);
      element.parentElement = this;
    }
  }
  remove(): void {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  private matches(selector: string): boolean {
    const tag = selector.match(/^[\w-]+/)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) => name !== undefined && name in this.attributes && (value === undefined || this.attributes[name] === value));
  }
  closest(selector: string): Element | null {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null;
  }
  querySelectorAll(selector: string): Element[] {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return descendants.filter(element => selector.split(',').some(alternative => {
      const parts = alternative.trim().split(/\s+/);
      if (!element.matches(parts.pop()!)) return false;
      let ancestor = element.parentElement;
      while (parts.length) {
        ancestor = ancestor?.closest(parts.pop()!) ?? null;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    }));
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  click(): void { this.clicked++; this.onClick?.(); }
  focus(): void { this.focused++; }
  dispatchEvent(event: Event): boolean { this.events.push(event); this.onEvent?.(event); return true; }
}

class FileTransfer {
  readonly files: File[] = [];
  readonly items = { add: (file: File) => { this.files.push(file); } };
}

interface PageOptions {
  menuDelay?: number;
  dialogDelay?: number;
  navigateWhileWaiting?: 'menu' | 'dialog';
  disconnectWhileWaiting?: boolean;
  existingDialog?: boolean;
  duplicateInputs?: boolean;
  disabledInput?: boolean;
  accept?: string;
  throwOnEvent?: 'input' | 'change';
}

function mediaPage(options: PageOptions = {}) {
  const calls: Array<{ version: number; files: File[] }> = [];
  const bodyInputs: Element[] = [];
  const root = new Element('#document');
  const body = new Element('BODY'); root.append(body);
  const toolbar = new Element('DIV', { id: 'toolbar-styling-buttons' });
  const emojiGroup = new Element('DIV'); emojiGroup.append(new Element('BUTTON', { 'data-testid': 'btn-emoji' }));
  const mediaGroup = new Element('DIV');
  const insert = new Element('BUTTON'), other = new Element('BUTTON'); mediaGroup.append(insert, other);
  toolbar.append(emojiGroup, mediaGroup);
  const cover = new Element('INPUT', { type: 'file', 'data-testid': 'fileInput' }); cover.accept = 'image/*';
  const editor = Object.assign(new Element('DIV', { contenteditable: 'true' }), {
    __reactFiber$fixture: {
      stateNode: { props: { editorState: { getCurrentContent: () => ({ getBlockMap: () => ({ toArray: () => [] }) }) } } },
      return: { memoizedProps: { value: { store: { getState: () => ({ entities: { articleEntities: { entities: { '123': { title: '', media_entities: [] } } } } }) } } } },
    },
  });
  editor.append(new Element('DIV', { 'data-contents': 'true' }));
  body.append(toolbar, cover, editor);
  if (options.existingDialog) body.append(new Element('DIV', { role: 'dialog' }));
  const location = { hostname: 'x.com', pathname: '/compose/articles/edit/123', href: 'https://x.com/compose/articles/edit/123' };
  let now = 0;
  let waitingFor: 'menu' | 'dialog' | undefined;
  let version = 0;
  let mediaClicks = 0;
  const scheduled: Array<{ at: number; callback: () => void }> = [];
  const schedule = (callback: () => void, delay = 0): void => {
    if (delay) scheduled.push({ at: now + delay, callback });
    else callback();
  };
  const showDialog = (): void => {
    waitingFor = undefined;
    const dialog = new Element('DIV', { role: 'dialog' });
    const input = new Element('INPUT', { type: 'file', multiple: '' });
    input.accept = options.accept ?? 'image/jpeg, image/png';
    input.disabled = options.disabledInput ?? false;
    const inputVersion = ++version;
    input.onEvent = event => {
      if (event.type === 'change') {
        calls.push({ version: inputVersion, files: [...input.files] });
        dialog.remove();
      }
      if (event.type === options.throwOnEvent) throw new Error('DOM dispatch failed after the input was assigned');
    };
    dialog.append(input);
    bodyInputs.push(input);
    if (options.duplicateInputs) dialog.append(new Element('INPUT', { type: 'file', multiple: '' }));
    body.append(dialog);
  };
  insert.onClick = () => {
    waitingFor = 'menu';
    schedule(() => {
      waitingFor = undefined;
      const menu = new Element('DIV', { role: 'menu' });
      const media = new Element('DIV', { role: 'menuitem' }, '媒体');
      const gif = new Element('DIV', { role: 'menuitem' }, 'GIF');
      media.onClick = () => {
        mediaClicks++;
        menu.remove();
        waitingFor = 'dialog';
        schedule(showDialog, options.dialogDelay);
      };
      menu.append(media, gif);
      body.append(menu);
    }, options.menuDelay);
  };
  const ranges: Array<{ element?: Element; atEnd?: boolean }> = [];
  const selection = { removeAllRanges: () => { ranges.length = 0; }, addRange: (range: { element?: Element; atEnd?: boolean }) => { ranges.push(range); } };
  const document = {
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    getElementById: (id: string) => root.querySelector(`[id="${id}"]`),
    createRange: () => {
      const range = {
        element: undefined as Element | undefined, atEnd: false,
        selectNodeContents: (element: Element) => { range.element = element; },
        collapse: (toStart: boolean) => { range.atEnd = !toStart; },
      };
      return range;
    },
  };
  const context = createContext({
    location, document, crypto: webcrypto, File, atob, Event, MouseEvent: class extends Event {}, DataTransfer: FileTransfer,
    window: { getSelection: () => selection },
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback: () => void, delay: number) {
      now += delay;
      if (waitingFor === options.navigateWhileWaiting && waitingFor !== undefined) location.pathname = '/home';
      if (options.disconnectWhileWaiting) editor.remove();
      for (const task of scheduled.filter(task => task.at <= now)) {
        scheduled.splice(scheduled.indexOf(task), 1);
        task.callback();
      }
      callback();
      return 1;
    },
  });
  const bridge: BrowserBridge = {
    // The compiled pageProgram.toString() executes with only browser globals.
    async evaluate<T>(expression: string): Promise<T> { return await runInContext(expression, context) as T; },
    async call() { throw new Error('Unexpected browser tool'); },
    async close() {},
  };
  return {
    bridge, calls, location, editor, cover, toolbar, insert, bodyInputs, ranges,
    elapsed: () => now, mediaClicks: () => mediaClicks,
    closeDialogs: () => { for (const dialog of root.querySelectorAll('[role="dialog"]')) dialog.remove(); },
  };
}

const uploadAction = (uploadId = 'upload-1'): PageAction => ({ kind: 'upload', id: '123', uploadId, asset: { name: 'photo.png', mime: 'image/png', base64: 'AQID' } });

async function assertNotSubmitted(page: ReturnType<typeof mediaPage>, reason: RegExp): Promise<void> {
  const response = await (await compiled)<{ state: string; reason: string }>(page.bridge, uploadAction());
  assert.equal(response.state, 'not-submitted');
  assert.match(response.reason, reason);
}

test('compiled upload assigns bytes to the body dialog and never to the always-mounted cover input', async () => {
  const page = mediaPage({ menuDelay: 200, dialogDelay: 300 }), run = await compiled;
  const before = await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123' });
  assert.ok(before.documentId);
  assert.equal((await run<{ state: string }>(page.bridge, uploadAction())).state, 'submitted');
  assert.equal(page.calls.length, 1);
  const file = page.calls[0]!.files[0]!;
  assert.equal(file.name, 'photo.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  const input = page.bodyInputs[0]!;
  assert.deepEqual(input.events.map(event => [event.type, event.bubbles, event.composed]), [['input', true, true], ['change', true, false]]);
  assert.equal(input.assignments, 1);
  assert.equal(page.cover.assignments, 0);
  assert.deepEqual(page.cover.events, []);
  assert.equal(page.insert.clicked, 1);
  assert.equal(page.mediaClicks(), 1);
  assert.equal(page.elapsed(), 500);
  assert.equal(page.ranges[0]?.element, page.editor);
  assert.equal(page.ranges[0]?.atEnd, true);
  const after = await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123', uploadId: 'upload-1' });
  assert.equal(after.documentId, before.documentId);
  assert.equal(after.upload?.state, 'submitted');
  assert.notEqual((await run<DraftSnapshot>(mediaPage().bridge, { kind: 'read', id: '123' })).documentId, before.documentId);
});

test('a repeated upload token does not reopen a removed dialog and a new token uses the remounted input', async () => {
  const page = mediaPage(), run = await compiled;
  await run(page.bridge, uploadAction());
  const first = page.bodyInputs[0]!;
  assert.equal(first.isConnected, false);
  await run(page.bridge, uploadAction());
  assert.equal(page.insert.clicked, 1);
  assert.equal(page.calls.length, 1);
  assert.equal(first.assignments, 1);
  await run(page.bridge, uploadAction('upload-2'));
  assert.deepEqual(page.calls.map(call => call.version), [1, 2]);
  assert.notEqual(page.bodyInputs[1], first);
  assert.equal(first.assignments, 1);
  assert.equal(page.bodyInputs[1]?.assignments, 1);
});

test('a dispatch failure is remembered as rejected without retrying the potentially submitted file', async () => {
  const run = await compiled;
  for (const throwOnEvent of ['input', 'change'] as const) {
    const page = mediaPage({ throwOnEvent });
    assert.equal((await run<{ state: string }>(page.bridge, uploadAction())).state, 'rejected');
    const snapshot = await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123', uploadId: 'upload-1' });
    assert.equal(snapshot.upload?.state, 'rejected');
    await run(page.bridge, uploadAction());
    assert.equal(page.insert.clicked, 1);
    assert.equal(page.bodyInputs[0]?.assignments, 1);
    assert.equal(page.calls.length, throwOnEvent === 'change' ? 1 : 0);
    assert.equal((await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123', uploadId: 'unknown' })).upload?.state, 'missing');
  }
});

test('navigation while waiting for either the menu or the body dialog prevents file submission', async () => {
  const run = await compiled;
  for (const stage of ['menu', 'dialog'] as const) {
    const page = mediaPage({ menuDelay: stage === 'menu' ? 500 : 0, dialogDelay: stage === 'dialog' ? 500 : 0, navigateWhileWaiting: stage });
    await assert.rejects(run(page.bridge, uploadAction()), /离开本次草稿/);
    assert.equal(page.calls.length, 0);
    assert.equal(page.cover.assignments, 0);
    assert.ok(page.bodyInputs.every(input => input.assignments === 0));
    assert.equal(page.elapsed(), 100);
    assert.equal(page.mediaClicks(), stage === 'menu' ? 0 : 1);
  }
  const replaced = mediaPage({ menuDelay: 500, disconnectWhileWaiting: true });
  await assert.rejects(run(replaced.bridge, uploadAction()), /编辑器已重建/);
  assert.equal(replaced.calls.length, 0);
});

test('existing dialogs, ambiguous body inputs and disabled toolbar controls return a definite non-submission', async () => {
  const run = await compiled;
  const existing = mediaPage({ existingDialog: true });
  await assertNotSubmitted(existing, /关闭.*弹窗/);
  assert.equal(existing.insert.clicked, 0);
  const duplicate = mediaPage({ duplicateInputs: true });
  await assertNotSubmitted(duplicate, /入口不唯一/);
  const disabled = mediaPage(); disabled.insert.disabled = true;
  await assertNotSubmitted(disabled, /工具栏已变化/);
  assert.equal(disabled.insert.clicked, 0);
  for (const page of [existing, duplicate, disabled]) {
    assert.equal(page.calls.length, 0);
    assert.equal(page.cover.assignments, 0);
    assert.ok(page.bodyInputs.every(input => input.assignments === 0));
    assert.equal((await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123', uploadId: 'upload-1' })).upload?.state, 'missing');
  }
});

test('a disabled body input times out with a virtual clock and unsupported formats are rejected', async () => {
  const run = await compiled;
  const disabled = mediaPage({ disabledInput: true });
  await assertNotSubmitted(disabled, /窗口未准备好/);
  assert.equal(disabled.elapsed(), 8000);
  const unsupported = mediaPage({ accept: 'image/jpeg' });
  await assertNotSubmitted(unsupported, /不接受此图片格式/);
  for (const page of [disabled, unsupported]) {
    assert.equal(page.calls.length, 0);
    assert.equal(page.bodyInputs[0]?.assignments, 0);
    assert.equal(page.cover.assignments, 0);
  }
  const wildcard = mediaPage({ accept: 'image/*' });
  await run(wildcard.bridge, uploadAction());
  assert.equal(wildcard.calls.length, 1);
});

test('a definitely unsubmitted token can be retried after its blocker is removed and submits only once', async () => {
  const run = await compiled;
  for (const blocker of ['dialog', 'toolbar', 'duplicate', 'disabled', 'format'] as const) {
    const options: PageOptions = {
      existingDialog: blocker === 'dialog', duplicateInputs: blocker === 'duplicate',
      disabledInput: blocker === 'disabled', accept: blocker === 'format' ? 'image/jpeg' : 'image/png',
    };
    const page = mediaPage(options);
    page.insert.disabled = blocker === 'toolbar';
    await assertNotSubmitted(page, /.+/);
    assert.equal(page.calls.length, 0);
    assert.equal((await run<DraftSnapshot>(page.bridge, { kind: 'read', id: '123', uploadId: 'upload-1' })).upload?.state, 'missing');
    page.closeDialogs();
    page.insert.disabled = false;
    options.duplicateInputs = false;
    options.disabledInput = false;
    options.accept = 'image/png';
    assert.equal((await run<{ state: string }>(page.bridge, uploadAction())).state, 'submitted');
    await run(page.bridge, uploadAction());
    assert.equal(page.calls.length, 1);
    assert.equal(page.bodyInputs.reduce((total, input) => total + input.assignments, 0), 1);
    assert.equal(page.cover.assignments, 0);
  }
});

test('wrong pages and absent editors stop uploads before the media toolbar is opened', async () => {
  const run = await compiled;
  const away = mediaPage(); away.location.pathname = '/home';
  await assert.rejects(run(away.bridge, uploadAction()), /离开本次草稿/);
  const missing = mediaPage(); missing.editor.remove();
  await assertNotSubmitted(missing, /编辑器尚未准备好/);
  for (const page of [away, missing]) {
    assert.equal(page.calls.length, 0);
    assert.equal(page.insert.clicked, 0);
  }
  assert.equal((await run<DraftSnapshot>(missing.bridge, { kind: 'read', id: '123', uploadId: 'upload-1' })).upload?.state, 'missing');
});

test('initial focus requires the intended editor and never opens the media toolbar or assigns files', async () => {
  const page = mediaPage(), run = await compiled;
  await run(page.bridge, { kind: 'focus', id: '123' });
  assert.equal(page.editor.focused, 1);
  assert.equal(page.insert.clicked, 0);
  assert.equal(page.bodyInputs.length, 0);
  assert.equal(page.cover.assignments, 0);
  page.location.pathname = '/home';
  await assert.rejects(run(page.bridge, { kind: 'focus', id: '123' }), /离开本次草稿/);
  assert.equal(page.editor.focused, 1);
});
