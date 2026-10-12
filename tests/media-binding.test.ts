import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { BrowserBridge, DraftRequest, UploadedMedia, XContent } from '../src/model';
import { saveDraft, type DraftSaveSession } from '../src/browser/x-draft';
import { createImageCheckpoint, verifyImageCheckpoint } from '../src/browser/x-page';
import type { DraftSnapshot } from '../src/browser/x-protocol';

interface Image { key: string; id: string; localId?: string; category?: string; }
function nativeDraft(images: Image[]) {
  return {
    blocks: [
      ...images.map((image, index) => ({ key: `block-${index}`, type: 'atomic', text: ' ', data: {}, entity_ranges: [{ key: image.key, offset: 0, length: 1 }], inline_style_ranges: [] })),
      { key: 'caret', type: 'unstyled', text: '', data: {}, entity_ranges: [], inline_style_ranges: [] },
    ],
    entity_map: images.map(image => ({ key: image.key, value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: image.id, ...(image.localId === undefined ? {} : { localMediaId: image.localId }), ...(image.category === undefined ? {} : { mediaCategory: image.category }) }] } } })),
  };
}

const first = { id: 'old-a', localId: 'local-a', category: 'DraftTweetImage', entityKey: 'entity-a' };
const second = { id: 'old-b', localId: 'local-b', category: 'DraftTweetImage', entityKey: 'entity-b' };
const uploaded = () => new Map<string, UploadedMedia>([['source-a', first], ['source-b', second]]);
function snapshot(images: Image[], saved = images.map(image => image.id)): DraftSnapshot {
  return { id: '123', url: 'https://x.com/compose/articles/edit/123', titleInputs: [''], saved: { title: '', cover: null, media: saved }, content: nativeDraft(images) };
}

test('checkpoint refreshes promoted IDs by entity key and emits the verified snake case protocol', () => {
  const checkpoint = createImageCheckpoint(nativeDraft([
    { key: 'entity-a', id: 'promoted-a', localId: 'local-a' },
    { key: 'entity-b', id: 'promoted-b', localId: 'local-b' },
  ]), uploaded());
  assert.equal(checkpoint.media.get('source-a')?.id, 'promoted-a');
  assert.deepEqual(checkpoint.content.entity_map[0]?.value.data, {
    entity_key: 'entity-a', media_items: [{ media_id: 'promoted-a', local_media_id: 'local-a', media_category: 'DraftTweetImage' }],
  });
  assert.equal(checkpoint.content.blocks.filter(block => block.type === 'atomic').length, 2);
});

test('reloaded media IDs follow unique local IDs even when entity keys are regenerated', () => {
  const checkpoint = createImageCheckpoint(nativeDraft([
    { key: 'entity-a', id: 'old-a', localId: 'local-a' },
    { key: 'entity-b', id: 'old-b', localId: 'local-b' },
  ]), uploaded());
  const actual = snapshot([
    { key: 'entity-b', id: 'persisted-a', localId: 'local-a' },
    { key: 'entity-a', id: 'persisted-b', localId: 'local-b' },
  ]);
  const verified = verifyImageCheckpoint(actual, checkpoint);
  assert.equal(verified.get('source-a')?.id, 'persisted-a');
  assert.equal(verified.get('source-a')?.entityKey, 'entity-b');
  actual.saved!.media.pop();
  assert.throws(() => verifyImageCheckpoint(actual, checkpoint), /预期 2 张，页面 2 张，已保存 1 张/);
});

test('optional native metadata is normalized but default local IDs are never trusted for identity', () => {
  const checkpoint = createImageCheckpoint(nativeDraft([{ key: 'entity-a', id: 'old-a' }]), new Map([['source-a', first]]));
  assert.equal(checkpoint.media.get('source-a')?.localId, '1');
  assert.equal(checkpoint.media.get('source-a')?.category, 'DraftTweetImage');
  assert.equal(verifyImageCheckpoint(snapshot([{ key: 'other-key', id: 'old-a' }]), checkpoint).get('source-a')?.id, 'old-a');
  // The submitted fallback may be echoed as an explicit local ID on reload.
  assert.throws(() => verifyImageCheckpoint(snapshot([{ key: 'other-key', id: 'changed', localId: '1' }]), checkpoint), /无法唯一对应/);
});

test('ambiguous or conflicting identities cannot be repaired by matching image positions', () => {
  const checkpoint = createImageCheckpoint(nativeDraft([
    { key: 'entity-a', id: 'old-a', localId: 'local-a' },
    { key: 'entity-b', id: 'old-b', localId: 'local-b' },
  ]), uploaded());
  assert.throws(() => verifyImageCheckpoint(snapshot([
    { key: 'entity-a', id: 'unknown-a', localId: 'new-local-a' },
    { key: 'entity-b', id: 'unknown-b', localId: 'new-local-b' },
  ]), checkpoint), /无法唯一对应/);
  assert.throws(() => createImageCheckpoint(nativeDraft([
    { key: 'entity-a', id: 'old-b', localId: 'local-a' },
    { key: 'entity-b', id: 'old-a', localId: 'local-b' },
  ]), uploaded()), /指向不同来源/);
  assert.throws(() => verifyImageCheckpoint(snapshot([
    { key: 'fresh-a', id: 'old-a', localId: 'local-b' },
    { key: 'fresh-b', id: 'old-b', localId: 'local-a' },
  ]), checkpoint), /指向不同来源/);
  assert.throws(() => verifyImageCheckpoint(snapshot([
    { key: 'fresh-b', id: 'old-b', localId: 'local-b' },
    { key: 'fresh-a', id: 'old-a', localId: 'local-a' },
  ]), checkpoint), /顺序/);
});

test('checkpoint rejects missing images and unexpected edits before any content replacement', () => {
  assert.throws(() => createImageCheckpoint(nativeDraft([]), uploaded()), /图片数量/);
  const changed = nativeDraft([{ key: 'entity-a', id: 'old-a', localId: 'local-a' }]);
  changed.blocks.at(-1)!.text = 'User edited this draft';
  assert.throws(() => createImageCheckpoint(changed, new Map([['source-a', first]])), /保护编辑内容/);
});

function fastPolling(t: TestContext): () => number {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay = 0) => { now += delay; queueMicrotask(callback); return 0; }) as unknown as typeof setTimeout);
  return () => now;
}

function simulatedUpload(options: { uploadError?: boolean; missingSavedMedia?: boolean; editorCounts?: readonly number[]; bindingDelayReads?: number; changedReloadBody?: boolean; invalidReload?: 'identity' | 'extra' | 'format' } = {}) {
  const request: DraftRequest = {
    title: 'Private title',
    blocks: [{ type: 'text', kind: 'unstyled', text: 'Private body', styles: [], links: [] }, ...Array.from({ length: 5 }, (_, index) => ({ type: 'image' as const, source: `private-source-${index}`, alt: '' }))],
    images: Array.from({ length: 5 }, (_, index) => ({ source: `private-source-${index}`, name: `private-name-${index}.png`, mime: 'image/png', base64: 'cHJpdmF0ZQ==' })),
  };
  const images: Image[] = [];
  const writes: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  const keys: string[] = [];
  let reloads = 0;
  let editorReads = 0;
  let uploads = 0;
  let readsAtFinalWrite: number | undefined;
  let title = '';
  let cover: string | null = null;
  let seed: XContent = { blocks: [{ key: 'empty', type: 'unstyled', text: '', data: {}, entity_ranges: [], inline_style_ranges: [] }], entity_map: [] };
  let finalContent: XContent | undefined;
  const bodyWithImages = (shown: Image[]) => {
    const media = nativeDraft(shown);
    return { blocks: [...seed.blocks.filter(block => block.text !== '' || block.type !== 'unstyled'), ...media.blocks], entity_map: [...seed.entity_map, ...media.entity_map] };
  };
  const bridge: BrowserBridge = {
    async call(name, args) {
      if (name === 'browser_press_key') keys.push(String(args.key));
      if (name === 'browser_navigate' && String(args.url).includes('/edit/')) {
        reloads++;
        if (reloads === 2) for (const [index, image] of images.entries()) { image.id = `persisted-${index}`; image.key = `reloaded-${index}`; }
      }
      return { content: [{ type: 'text', text: '- 0: [X](https://x.com/home)' }] };
    },
    async evaluate<T>(expression: string): Promise<T> {
      const action = JSON.parse(expression.slice(expression.lastIndexOf(')(') + 2, -1)) as { kind?: string; uploadId?: string; operation?: string; variables?: Record<string, unknown> };
      if (action.kind === 'create') return { previous: [] } as T;
      if (action.kind === 'toast' || action.kind === 'focus') return true as T;
      if (action.kind === 'upload') {
        const index = uploads++;
        if (options.uploadError) return { state: 'rejected' } as T;
        images.push({ key: `upload-${index}`, id: `temporary-${index}`, localId: `local-${index}` });
        return { state: 'submitted' } as T;
      }
      if (action.operation && action.variables) {
        if (action.operation === 'ArticleEntityUpdateTitle') { title = String(action.variables.title); readsAtFinalWrite ??= editorReads; }
        if (action.operation === 'ArticleEntityUpdateCoverMedia') cover = (action.variables.coverMedia as { media_id: string }).media_id;
        if (action.operation === 'ArticleEntityUpdateContent') {
          if (!uploads) seed = structuredClone(action.variables.content_state as XContent);
          else finalContent = structuredClone(action.variables.content_state as XContent);
        }
        writes.push({ operation: action.operation, variables: action.variables });
        return { status: 200, body: { data: { updated: { id: '123' } } } } as T;
      }
      const result: DraftSnapshot = { ...snapshot(images), documentId: `doc-${reloads}`, content: finalContent ?? bodyWithImages(images) };
      result.saved!.title = title;
      result.saved!.cover = cover;
      result.titleInputs = [title];
      if (action.uploadId) result.upload = { state: options.uploadError ? 'rejected' : 'submitted' };
      if (reloads === 2 && !finalContent) {
        editorReads++;
        if (options.missingSavedMedia || editorReads <= (options.bindingDelayReads ?? 0)) result.saved!.media = [];
        if (options.editorCounts?.length) result.content = bodyWithImages(images.slice(0, options.editorCounts[Math.min(editorReads - 1, options.editorCounts.length - 1)]));
        if (options.invalidReload === 'identity') result.content = bodyWithImages(images.map((image, index) => ({ ...image, id: `temporary-${index}`, localId: `local-${(index + 1) % images.length}` })));
        if (options.invalidReload === 'extra') result.content = bodyWithImages([...images, { key: 'extra', id: 'extra', localId: 'extra' }]);
        if (options.invalidReload === 'format') (result.content as XContent).entity_map.find(entity => entity.value.type === 'MEDIA')!.value.data = { mediaItems: [] };
        if (options.changedReloadBody) (result.content as XContent).blocks[0]!.text = 'Edited in X before the reload completed';
      }
      return result as T;
    },
    async close() { throw new Error('Connection is owned by caller'); },
  };
  return { bridge, request, writes, keys, reloads: () => reloads, editorReads: () => editorReads, uploads: () => uploads, readsAtFinalWrite: () => readsAtFinalWrite };
}

test('native media are reloaded and reconciled before canonical final content writes', async t => {
  fastPolling(t);
  const run = simulatedUpload();
  const events: Array<{ event: string; details: unknown }> = [];
  await saveDraft(run.bridge, run.request, () => undefined, (event, details) => events.push({ event, details }));
  assert.deepEqual(run.keys, [process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End']);
  assert.equal(run.uploads(), 5);
  assert.equal(run.reloads(), 3);
  assert.deepEqual(run.writes.map(write => write.operation), ['ArticleEntityUpdateContent', 'ArticleEntityUpdateTitle', 'ArticleEntityUpdateContent']);
  const seed = run.writes[0]!.variables.content_state as XContent;
  assert.equal(seed.blocks[0]?.text, 'Private body');
  assert.equal(seed.entity_map.length, 0);
  const finalWrite = run.writes.at(-1)!.variables.content_state as XContent;
  assert.equal(finalWrite.blocks[0]?.text, 'Private body');
  assert.ok(JSON.stringify(finalWrite).includes('persisted-4'));
  assert.ok(!JSON.stringify(finalWrite).includes('temporary-'));
  assert.equal(events.filter(item => item.event === 'mutation-result').length, 3);
  assert.ok(!/Private|private-|cHJpdmF0ZQ|temporary-|persisted-|https/.test(JSON.stringify(events)));
});

test('upload errors or missing bindings stop before final API writes and preserve recovery URL', async t => {
  fastPolling(t);
  for (const options of [{ uploadError: true }, { missingSavedMedia: true }]) {
    const run = simulatedUpload(options);
    const events: unknown[] = [];
    await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, (event, details) => events.push({ event, details })), /https:\/\/x\.com\/compose\/articles\/edit\/123/);
    assert.equal(run.writes.length, 1, 'only the seed body was submitted');
    assert.ok(!/private|https/.test(JSON.stringify(events)));
  }
});

test('reload waits for editor hydration or image binding without another upload', async t => {
  fastPolling(t);
  for (const [options, readyRead] of [[{ editorCounts: [0, 2, 5] }, 3], [{ bindingDelayReads: 3 }, 4]] as const) {
    const run = simulatedUpload(options);
    await saveDraft(run.bridge, run.request, () => undefined);
    assert.equal(run.readsAtFinalWrite(), readyRead);
    assert.equal(run.uploads(), 5);
    assert.equal(run.reloads(), 3);
    assert.equal(run.writes.length, 3);
  }
});

test('permanently missing editor images time out without final writes or reupload', async t => {
  fastPolling(t);
  const run = simulatedUpload({ editorCounts: [0, 4] });
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined), /等待草稿重新加载超时：图片数量不一致：预期 5 张，编辑器 4 张/);
  assert.equal(run.uploads(), 5);
  assert.equal(run.reloads(), 2);
  assert.equal(run.writes.length, 1);
});

test('reload identity conflicts, extra images and malformed content stop on the first read', async t => {
  fastPolling(t);
  for (const invalidReload of ['identity', 'extra', 'format'] as const) {
    const run = simulatedUpload({ invalidReload });
    await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined), /指向不同来源|预期 5 张，编辑器 6 张|每个上传图片实体必须对应一张图片/);
    assert.equal(run.editorReads(), 1);
    assert.equal(run.uploads(), 5);
    assert.equal(run.reloads(), 2);
    assert.equal(run.writes.length, 1);
  }
});

test('repeated body sources upload once and an independent cover is excluded from the final body', async t => {
  fastPolling(t);
  const run = simulatedUpload();
  const body = run.request.images[0]!;
  run.request.blocks = [{ type: 'image', source: body.source, alt: '' }, { type: 'image', source: body.source, alt: '' }];
  run.request.images = [body];
  run.request.cover = { source: 'cover', name: 'cover.png', mime: 'image/png', base64: 'Y292ZXI=' };
  await saveDraft(run.bridge, run.request, () => undefined);
  assert.equal(run.uploads(), 2);
  const contentWrites = run.writes.filter(write => write.operation === 'ArticleEntityUpdateContent');
  assert.equal(contentWrites.length, 1, 'an image-only article does not submit an empty seed body');
  const final = contentWrites[0]!.variables.content_state as XContent;
  assert.equal(final.entity_map.length, 2);
  assert.ok(final.entity_map.every(entity => JSON.stringify(entity).includes('persisted-0')));
  assert.ok(!JSON.stringify(final).includes('persisted-1'));
  assert.deepEqual(run.writes.at(-1)!.variables.coverMedia, { media_id: 'persisted-1', media_category: 'DraftTweetImage' });
});

test('using a body image as cover preserves it without another native upload', async t => {
  fastPolling(t);
  const run = simulatedUpload();
  run.request.cover = run.request.images[2];
  await saveDraft(run.bridge, run.request, () => undefined);
  assert.equal(run.uploads(), 5);
  assert.deepEqual(run.writes.at(-1)!.variables.coverMedia, { media_id: 'persisted-2', media_category: 'DraftTweetImage' });
});

test('changed non-image body after upload reload prevents all final mutations', async t => {
  fastPolling(t);
  const run = simulatedUpload({ changedReloadBody: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /正文/);
  assert.equal(session.resumable, false);
  assert.equal(run.writes.length, 1);
  assert.equal(run.editorReads(), 1);
});

test('a throwing diagnostic sink does not change a verified save result', async t => {
  fastPolling(t);
  const run = simulatedUpload();
  assert.equal((await saveDraft(run.bridge, run.request, () => undefined, () => { throw new Error('logger unavailable'); })).id, '123');
});
