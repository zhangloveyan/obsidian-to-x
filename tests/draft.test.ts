import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserBridge, DraftRequest, XContent } from '../src/model';
import { serializeContent } from '../src/content/article';
import { saveDraft } from '../src/browser/x-draft';
import { PageChangedError, PageOperationError, runPage, waitFor } from '../src/browser/x-page';
import { verifyContent, verifyDraft, verifyMutation } from '../src/browser/x-protocol';
import type { DraftSnapshot } from '../src/browser/x-protocol';

const article: XContent = {
  blocks: [
    { key: 'a', type: 'header-one', text: '标题 👋 link', data: {}, inline_style_ranges: [{ offset: 0, length: 2, style: 'Bold' }], entity_ranges: [{ key: 0, offset: 6, length: 4 }] },
    { key: 'b', type: 'ordered-list-item', text: '第一项', data: {}, inline_style_ranges: [{ offset: 0, length: 3, style: 'Italic' }], entity_ranges: [] },
    { key: 'c', type: 'atomic', text: ' ', data: {}, inline_style_ranges: [], entity_ranges: [{ key: 1, offset: 0, length: 1 }] },
    { key: 'd', type: 'atomic', text: ' ', data: {}, inline_style_ranges: [], entity_ranges: [{ key: 2, offset: 0, length: 1 }] },
    { key: 'e', type: 'atomic', text: ' ', data: {}, inline_style_ranges: [], entity_ranges: [{ key: 3, offset: 0, length: 1 }] },
  ],
  entity_map: [
    { key: '0', value: { type: 'LINK', mutability: 'MUTABLE', data: { url: 'https://example.com/path' } } },
    { key: '1', value: { type: 'MARKDOWN', mutability: 'IMMUTABLE', data: { markdown: '```js\nconst value = 42;\n```' } } },
    { key: '2', value: { type: 'MARKDOWN', mutability: 'IMMUTABLE', data: { markdown: '| A | B |\n| --- | --- |\n| 1 | 2 |' } } },
    { key: '3', value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { media_items: [{ media_id: '567890', local_media_id: '1', media_category: 'DraftTweetImage' }] } } },
  ],
};

function snapshot(): DraftSnapshot {
  return { id: '123', url: 'https://x.com/compose/articles/edit/123', titleInputs: ['完整标题 👋'], saved: { title: '完整标题 👋', cover: '567890', media: ['567890'] }, content: structuredClone(article) };
}

test('GraphQL requires successful HTTP, no errors and non-null data', () => {
  verifyMutation({ status: 200, body: { data: { saved: { id: '123' } }, errors: [] } }, '保存');
  for (const response of [
    { status: 403, body: { data: { saved: true } } },
    { status: 200, body: { errors: [{ message: 'Denied' }], data: { saved: true } } },
    { status: 200, body: { data: { saved: null } } },
    { status: 200, body: {} },
    { status: 200, body: null },
  ]) assert.throws(() => verifyMutation(response, '保存'));
});

test('verification preserves full title, paragraph kind, formatting and bound media', () => {
  verifyDraft(snapshot(), '123', '完整标题 👋', article, '567890');
  const wrongTitle = snapshot();
  wrongTitle.titleInputs = ['完整标题'];
  assert.throws(() => verifyDraft(wrongTitle, '123', '完整标题 👋', article, '567890'), /标题/);
  const missingMedia = snapshot();
  missingMedia.saved!.media = [];
  assert.throws(() => verifyDraft(missingMedia, '123', '完整标题 👋', article, '567890'), /图片/);
  const wrongCover = snapshot();
  wrongCover.saved!.cover = 'different';
  assert.throws(() => verifyDraft(wrongCover, '123', '完整标题 👋', article, '567890'), /封面/);
  assert.throws(() => verifyDraft(snapshot(), '456', '完整标题 👋', article, '567890'), /离开/);
});

test('emoji decoration and editor keys can change without hiding text or style loss', () => {
  const actual = structuredClone(article);
  actual.blocks[0]!.key = 'new-key';
  actual.entity_map.push({ key: '4', value: { type: 'TWEMOJI', mutability: 'IMMUTABLE', data: { url: 'https://example.com/emoji.svg' } } });
  actual.blocks[0]!.entity_ranges.push({ key: 4, offset: 3, length: 2 });
  actual.blocks[0]!.inline_style_ranges = [{ offset: 0, length: 1, style: 'Bold' }, { offset: 1, length: 1, style: 'Bold' }];
  actual.blocks.push({ key: 'caret', type: 'unstyled', text: '', data: {}, inline_style_ranges: [], entity_ranges: [] });
  verifyContent(article, actual);
  actual.blocks[0]!.inline_style_ranges.pop();
  assert.throws(() => verifyContent(article, actual), /样式/);
  actual.blocks[0]!.text = '标题 🙂 link';
  assert.throws(() => verifyContent(article, actual), /文字/);
});

test('body verification detects changed list kind, links, code, table and image IDs', () => {
  const wrongKind = structuredClone(article);
  wrongKind.blocks[1]!.type = 'unordered-list-item';
  assert.throws(() => verifyContent(article, wrongKind), /类型/);
  for (let index = 0; index < article.entity_map.length; index++) {
    const actual = structuredClone(article);
    const data = actual.entity_map[index]!.value.data;
    if (index === 0) data.url = 'https://example.com/other';
    else if (index < 3) data.markdown = 'different text';
    else data.media_items = [{ media_id: 'other-id' }];
    assert.throws(() => verifyContent(article, actual), /链接、图片、代码或表格/);
  }
});

test('camelCase media payload survives reload while missing or invalid entities fail', () => {
  const actual = structuredClone(article);
  actual.entity_map[3]!.value.data = { mediaItems: [{ mediaId: '567890', localMediaId: 'other-local-id' }] };
  verifyContent(article, actual);
  actual.entity_map.pop();
  assert.throws(() => verifyContent(article, actual), /不存在/);
  const invalidRange = structuredClone(article);
  invalidRange.blocks[0]!.inline_style_ranges[0]!.length = 100;
  assert.throws(() => verifyContent(article, invalidRange), /范围/);
});

function simulatedBrowser(options: { existing?: boolean; mutationError?: boolean; initialCover?: string; initialText?: string; movedBeforeReload?: boolean } = {}): { bridge: BrowserBridge; calls: Array<{ name: string; args: Record<string, unknown> }>; request: DraftRequest } {
  const request: DraftRequest = { title: 'Contract test', blocks: [{ type: 'text', kind: 'unstyled', text: 'Complete body', styles: [], links: [] }], images: [] };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let mutations = 0;
  const bridge: BrowserBridge = {
    async call(name, args) {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: '- 0: [Example](https://example.com/)\n- 1: (current) [X](https://x.com/home)' }] };
    },
    async evaluate<T>(expression: string): Promise<T> {
      const action = (expression.endsWith(')()') && expression.includes('function createArticleDraft(') ? { kind: 'create' }
        : JSON.parse(expression.slice(expression.lastIndexOf(')(') + 2, -1))) as { kind?: string; operation?: string };
      if (action.kind === 'create') return { previous: options.existing ? ['123'] : [] } as T;
      if (action.operation) {
        mutations++;
        return { status: 200, body: options.mutationError ? { errors: [{ message: 'Denied' }] } : { data: { saved: { id: '123' } } } } as T;
      }
      if (action.kind === 'toast') return true as T;
      const ready = mutations === 2;
      if (ready && options.movedBeforeReload) throw new Error('MXP_PAGE_CHANGED: 浏览器已离开本次草稿，操作已停止。');
      return {
        id: '123', url: 'https://x.com/compose/articles/edit/123',
        content: serializeContent(ready ? request.blocks : [{ type: 'text', kind: 'unstyled', text: options.initialText ?? '', styles: [], links: [] }], new Map()),
        titleInputs: [ready ? request.title : ''], saved: { title: ready ? request.title : '', cover: options.initialCover ?? null, media: [] },
      } as T;
    },
    async close() { throw new Error('Adapter must not close the caller-owned bridge'); },
  };
  return { bridge, calls, request };
}

test('orchestrator reuses an X tab, creates a blank draft and returns only after reload verification', async () => {
  const { bridge, calls, request } = simulatedBrowser();
  const updates: string[] = [];
  const result = await saveDraft(bridge, request, message => updates.push(message));
  assert.equal(result.url, 'https://x.com/compose/articles/edit/123');
  assert.ok(calls.some(call => call.name === 'browser_tabs' && call.args.action === 'select' && call.args.index === 1));
  assert.ok(!calls.some(call => call.name === 'browser_tabs' && call.args.action === 'new'));
  assert.equal(calls.filter(call => call.name === 'browser_navigate').length, 2);
  assert.equal(updates.at(-1), '草稿已保存并核对。');
});

test('existing draft and failed mutations never succeed and retain the recovery URL', async () => {
  for (const options of [{ existing: true }, { mutationError: true }, { initialCover: '456' }, { initialText: ' ' }]) {
    const { bridge, request } = simulatedBrowser(options);
    const updates: string[] = [];
    await assert.rejects(() => saveDraft(bridge, request, message => updates.push(message)), /https:\/\/x\.com\/compose\/articles\/edit\/123/);
    assert.ok(!updates.includes('草稿已保存并核对。'));
  }
});

test('moving away stops polling immediately and does not navigate back to the draft', async () => {
  let probes = 0;
  await assert.rejects(() => waitFor('test', async () => { probes++; throw new PageChangedError(); }), PageChangedError);
  assert.equal(probes, 1);
  const { bridge, calls, request } = simulatedBrowser({ movedBeforeReload: true });
  await assert.rejects(() => saveDraft(bridge, request, () => undefined), /浏览器已离开/);
  assert.equal(calls.filter(call => call.name === 'browser_navigate').length, 1);
});

test('invalid formatting fails before creating or navigating any browser page', async () => {
  const { bridge, calls, request } = simulatedBrowser();
  request.blocks = [{ type: 'text', kind: 'unstyled', text: 'short', styles: [{ style: 'Bold', offset: 0, length: 100 }], links: [] }];
  await assert.rejects(() => saveDraft(bridge, request, () => undefined), /formatting range/);
  assert.equal(calls.length, 0);
});

test('conflicting bytes or MIME types for one image source fail before any browser call', async () => {
  const image = { source: 'same.png', name: 'same.png', mime: 'image/png', base64: 'aW1hZ2U=' };
  for (const conflict of [{ ...image, base64: 'b3RoZXI=' }, { ...image, mime: 'image/jpeg' }]) {
    for (const coverConflict of [false, true]) {
      const { bridge, calls, request } = simulatedBrowser();
      request.blocks.push({ type: 'image', source: image.source, alt: '' });
      request.images = coverConflict ? [image] : [image, conflict];
      if (coverConflict) request.cover = conflict;
      await assert.rejects(() => saveDraft(bridge, request, () => undefined), /同一来源的图片数据不一致/);
      assert.deepEqual(calls, []);
    }
  }
});

test('ambiguous controls and script errors stop after one attempt instead of timing out', async () => {
  for (const message of ['### Error\nError: MXP_CREATE_AMBIGUOUS: 未找到唯一的新建文章入口（找到 2 个）\n at pageProgram', 'ReferenceError: missingValue is not defined']) {
    let probes = 0;
    const bridge: BrowserBridge = {
      async evaluate() { probes++; throw new Error(message); },
      async call() { throw new Error('unexpected browser action'); },
      async close() {},
    };
    await assert.rejects(() => waitFor('新建', () => runPage(bridge, { kind: 'create' })), PageOperationError);
    assert.equal(probes, 1);
  }
});
