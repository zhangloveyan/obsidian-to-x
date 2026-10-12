import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { BrowserBridge, DiagnosticSink, MediaAsset } from '../src/model';
import { uploadArticleMedia, type MediaUploadSession } from '../src/browser/media-upload';
import { PageChangedError, ResumeRejectedError, type PageAction } from '../src/browser/x-page';
import type { DraftSnapshot } from '../src/browser/x-protocol';

interface Image { id?: string; key: string; localId?: string | number | null; category?: string | null; snake?: boolean; }
interface Clock { now(): number; advance(milliseconds: number): void; }
function clock(t: TestContext): Clock {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay = 0) => { now += delay; queueMicrotask(callback); return 0; }) as unknown as typeof setTimeout);
  return { now: () => now, advance: milliseconds => { now += milliseconds; } };
}

function draft(images: Image[], text = 'Private article body', middleBlank = false) {
  const paragraph = (key: string, text: string) => ({ key, type: 'unstyled', text, data: {}, entity_ranges: [], inline_style_ranges: [] });
  return {
    blocks: [
      paragraph('text', text),
      ...(middleBlank ? [paragraph('inserted-empty', ''), paragraph('extra-text', 'Changed content')] : []),
      ...images.map((image, index) => ({ key: `block-${index}`, type: 'atomic', text: ' ', data: {}, entity_ranges: [{ key: image.key, offset: 0, length: 1 }], inline_style_ranges: [] })),
      paragraph('caret', ''),
    ],
    entity_map: images.map(image => {
      // A normal native observation carries these fields; null models hydration
      // that has not supplied them, rather than relying on production defaults.
      const localId = image.localId === null ? undefined : image.localId ?? `fixture-local-${image.key}`;
      const category = image.category === null ? undefined : image.category ?? 'DraftTweetImage';
      return { key: image.key, value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: image.snake ? {
        media_items: [{ media_id: image.id, ...(localId === undefined ? {} : { local_media_id: localId }), ...(category === undefined ? {} : { media_category: category }) }],
      } : {
        mediaItems: [{ mediaId: image.id, ...(localId === undefined ? {} : { localMediaId: localId }), ...(category === undefined ? {} : { mediaCategory: category }) }],
      } } };
    }),
  };
}

function assets(count = 3): MediaAsset[] {
  return Array.from({ length: count }, (_, index) => ({ source: `/private/folder/source-${index}.png`, name: `private-image-${index}.png`, mime: 'image/png', base64: `private-file-payload-${index}` }));
}

class NativePage implements BrowserBridge {
  readonly attempts: string[] = [];
  readonly uploads: Array<{ id: string; asset: Pick<MediaAsset, 'name' | 'mime' | 'base64'>; at: number }> = [];
  readonly tokens = new Map<string, 'submitted' | 'rejected'>();
  images: Image[] = [];
  articleId = '123';
  documentId: string | undefined = 'document-a';
  body = 'Private article body';
  middleBlank = false;
  unavailable = false;
  savedIds: string[] | undefined;
  reads = 0;
  uploadReads = 0;
  beforeRead?: (page: NativePage, action: Extract<PageAction, { kind: 'read' }>) => void;
  preflight?: (page: NativePage) => { state: string; reason?: string } | undefined;
  onUpload?: (page: NativePage, action: Extract<PageAction, { kind: 'upload' }>) => void | 'drop' | 'reject';
  constructor(readonly time: Clock, readonly session: MediaUploadSession) {}
  async evaluate<T>(expression: string): Promise<T> {
    const start = expression.lastIndexOf(')(');
    assert.ok(start >= 0, 'expected serialized page action');
    const action = JSON.parse(expression.slice(start + 2, -1)) as PageAction;
    if (action.kind === 'upload') {
      assert.equal(this.session.pending?.uploadId, action.uploadId, 'pending must be saved before submitting to the browser');
      assert.equal(action.id, this.articleId);
      this.attempts.push(action.uploadId);
      if (!this.tokens.has(action.uploadId)) {
        const prevented = this.preflight?.(this);
        if (prevented) return prevented as T;
        this.tokens.set(action.uploadId, 'submitted');
        this.uploads.push({ id: action.uploadId, asset: action.asset, at: this.time.now() });
        this.uploadReads = 0;
        if (!this.onUpload) this.images.push({ id: `private-media-${this.uploads.length}`, localId: `private-local-${this.uploads.length}`, key: `entity-${this.uploads.length}`, snake: this.uploads.length % 2 === 0 });
        const mode = this.onUpload?.(this, action);
        if (mode === 'drop') throw new Error('native submission reply lost');
        if (mode === 'reject') this.tokens.set(action.uploadId, 'rejected');
      }
      return { state: this.tokens.get(action.uploadId) } as T;
    }
    assert.equal(action.kind, 'read');
    if (action.kind !== 'read') throw new Error('Unexpected page action');
    this.reads++;
    if (action.uploadId) this.uploadReads++;
    this.beforeRead?.(this, action);
    const value: DraftSnapshot = {
      id: this.articleId, url: `https://x.com/compose/articles/edit/${this.articleId}`, documentId: this.documentId,
      content: this.unavailable ? null : draft(this.images, this.body, this.middleBlank), titleInputs: ['Private title'],
      saved: { title: 'Private title', cover: null, media: this.savedIds ?? this.images.flatMap(image => image.id ? [image.id] : []) },
      ...(action.uploadId ? { upload: { state: this.tokens.get(action.uploadId) ?? 'missing' } } : {}),
    };
    return value as T;
  }
  async call(): Promise<never> { throw new Error('Unexpected browser tool'); }
  async close(): Promise<never> { throw new Error('Unexpected close'); }
}

function setup(t: TestContext, count = 3) {
  const time = clock(t);
  const session: MediaUploadSession = {};
  const page = new NativePage(time, session);
  const files = assets(count);
  const messages: string[] = [];
  const events: Array<{ event: string; details?: Parameters<DiagnosticSink>[1] }> = [];
  const run = (articleId = '123', input = files) => uploadArticleMedia(page, articleId, input, message => messages.push(message), (event, details) => events.push({ event, details }), session);
  return { time, session, page, files, messages, events, run };
}

test('four native uploads survive complete entity-key rebuilding and use distinct stable confirmation windows', async t => {
  const { page, run, files, session } = setup(t, 4);
  page.beforeRead = state => { state.images = state.images.map((image, index) => ({ ...image, key: `read-${state.reads}-key-${index}` })); };
  const result = await run();
  assert.deepEqual(result.map(image => image.source), files.map(file => file.source));
  assert.deepEqual(result.map(image => image.id), ['private-media-1', 'private-media-2', 'private-media-3', 'private-media-4']);
  assert.equal(page.uploads.length, 4);
  for (let index = 1; index < page.uploads.length; index++) assert.ok(page.uploads[index]!.at - page.uploads[index - 1]!.at >= 500);
  assert.equal(session.pending, undefined);
  assert.strictEqual(session.result, result);
});

test('identity aliases survive repeated ID and local-ID promotions while saved binding lags', async t => {
  const { page, run } = setup(t, 2);
  page.beforeRead = state => {
    if (state.uploads.length !== 2) return;
    const first = state.images[0]!;
    if (state.uploadReads === 1) { first.id = 'promoted-a'; first.localId = 'private-local-1'; first.key = 'new-a'; state.savedIds = ['private-media-1', 'private-media-2']; }
    if (state.uploadReads === 2) { first.localId = 'promoted-local'; first.key = 'new-b'; }
    if (state.uploadReads === 3) { first.id = 'promoted-b'; first.key = 'new-c'; }
    if (state.uploadReads >= 4) { first.id = 'private-media-1'; first.localId = 'promoted-again'; first.key = 'new-d'; state.savedIds = undefined; }
  };
  const result = await run();
  assert.equal(result[0]?.id, 'private-media-1');
  assert.equal(result[0]?.localId, 'promoted-again');
  assert.equal(page.uploads.length, 2);
});

test('uniquely identified old images retain observed metadata while missing fields and same-document IDs hydrate', async t => {
  const { page, run } = setup(t, 2);
  page.onUpload = state => {
    state.images.push({ id: `native-${state.uploads.length}`, key: `key-${state.uploads.length}`, localId: `native-local-${state.uploads.length}`, category: 'ObservedArticleImage' });
    if (state.uploads.length === 2) Object.assign(state.images[0]!, { id: 'promoted-with-key', localId: null, category: null });
  };
  const result = await run();
  assert.equal(result[0]?.id, 'promoted-with-key');
  assert.equal(result[0]?.localId, 'native-local-1');
  assert.ok(result.every(image => image.category === 'ObservedArticleImage' && image.localIdIsFallback === false));
});

test('losing an old image prevents the next submission even when a new image appears', async t => {
  const { page, run } = setup(t);
  page.onUpload = state => {
    state.images.push({ id: `media-${state.uploads.length}`, localId: `local-${state.uploads.length}`, key: `key-${state.uploads.length}` });
    if (state.uploads.length === 2) state.images.shift();
  };
  await assert.rejects(run(), /旧图片丢失/);
  assert.equal(page.uploads.length, 2, 'third file must not be submitted');
});

test('an old image removed between confirmation and the next upload is caught before submission', async t => {
  const { page, run } = setup(t);
  page.beforeRead = (state, action) => { if (!action.uploadId && state.uploads.length === 1) state.images = []; };
  await assert.rejects(run(), /旧图片丢失/);
  assert.equal(page.uploads.length, 1);
});

test('an actual extra image is never guessed to be the requested file', async t => {
  const { page, run } = setup(t);
  page.onUpload = state => { state.images.push({ id: 'requested', localId: 'requested-local', key: 'requested-key' }, { id: 'unexpected', localId: 'unexpected-local', key: 'unexpected-key' }); };
  await assert.rejects(run(), /额外图片/);
  assert.equal(page.uploads.length, 1);
});

test('unique media ID and local ID pointing at different sources immediately stop the batch', async t => {
  const { page, run } = setup(t, 4);
  page.onUpload = state => {
    state.images.push({ id: `media-${state.uploads.length}`, localId: `local-${state.uploads.length}`, key: `key-${state.uploads.length}` });
    if (state.uploads.length === 3) {
      state.images[0]!.localId = 'local-2';
      state.images[1]!.localId = 'local-1';
    }
  };
  await assert.rejects(run(), /MXP_MEDIA_IDENTITY_AMBIGUOUS.*指向不同来源/);
  assert.equal(page.uploads.length, 3);
});

test('saved-media binding and native readiness must settle before the next file starts', async t => {
  const { page, run } = setup(t, 2);
  page.onUpload = state => {
    state.images.push({ key: `key-${state.uploads.length}`, localId: `local-${state.uploads.length}` });
    state.savedIds = state.images.flatMap(image => image.id ? [image.id] : []);
  };
  page.beforeRead = state => {
    if (!state.uploads.length) return;
    if (state.uploadReads >= 3) state.images.at(-1)!.id = `media-${state.uploads.length}`;
    if (state.uploadReads >= 6) state.savedIds = undefined;
  };
  await run();
  assert.ok(page.uploads[1]!.at >= 3000, 'second upload waits for native ID, saved binding, and two stable reads');
});

test('new-image metadata can arrive across different snapshots without inventing either field', async t => {
  const { page, run } = setup(t, 2);
  page.onUpload = state => {
    state.images.push({ id: `media-${state.uploads.length}`, key: `key-${state.uploads.length}`, localId: state.uploads.length + 1, category: state.uploads.length === 1 ? null : 'ObservedArticleImage' });
  };
  page.beforeRead = state => {
    if (state.uploads.length === 1 && state.uploadReads >= 3) {
      state.images[0]!.localId = null;
      state.images[0]!.category = 'ObservedArticleImage';
    }
  };
  const result = await run();
  assert.ok(page.uploads[1]!.at >= 1500, 'the next file waits until both fields have been observed and confirmed stable');
  assert.equal(result[0]?.localId, '2');
  assert.equal(result[0]?.category, 'ObservedArticleImage');
  assert.equal(result[0]?.localIdIsFallback, false);
});

for (const field of ['localId', 'category'] as const) {
  test(`missing native ${field} times out without the next upload and resumes when the real value arrives`, async t => {
    const { page, run, session, time, events } = setup(t, 2);
    page.onUpload = state => {
      state.images.push({ id: `media-${state.uploads.length}`, key: `key-${state.uploads.length}`, localId: `native-local-${state.uploads.length}`, category: 'ObservedArticleImage' });
      if (state.uploads.length === 1) state.images[0]![field] = null;
    };
    await assert.rejects(run(), /MXP_MEDIA_STATE_UNSTABLE.*180 秒/);
    assert.equal(time.now(), 180_000);
    assert.equal(page.uploads.length, 1);
    assert.ok(session.pending);
    assert.equal(session.result, undefined);
    assert.equal(session.pending.candidate?.current[field], '');
    assert.ok(events.some(event => event.details?.state === 'metadata_pending' && event.details.pending === 1));
    page.images[0]![field] = field === 'localId' ? 'native-local-1' : 'ObservedArticleImage';
    const result = await run();
    assert.equal(page.uploads.length, 2);
    assert.equal(result[0]?.localId, 'native-local-1');
    assert.equal(result[0]?.category, 'ObservedArticleImage');
    assert.ok(result.every(image => image.localIdIsFallback === false));
  });
}

test('a partially observed pending image cannot be replaced by an unrelated image after metadata timeout', async t => {
  const { page, run, session } = setup(t, 1);
  page.onUpload = state => { state.images = [{ id: 'original-id', key: 'original-key', localId: null, category: 'ObservedArticleImage' }]; };
  await assert.rejects(run(), /MXP_MEDIA_STATE_UNSTABLE/);
  const token = session.pending?.uploadId;
  page.documentId = 'reloaded';
  page.images = [{ id: 'unrelated-id', key: 'unrelated-key', localId: 'unrelated-local', category: 'ObservedArticleImage' }];
  await assert.rejects(run(), /MXP_MEDIA_IDENTITY_AMBIGUOUS/);
  assert.equal(session.pending?.uploadId, token);
  assert.equal(page.uploads.length, 1);
});

test('observed category conflicts still stop before a later file can be submitted', async t => {
  const { page, run } = setup(t, 3);
  page.onUpload = state => {
    state.images.push({ id: `media-${state.uploads.length}`, key: `key-${state.uploads.length}`, localId: `native-local-${state.uploads.length}`, category: 'ObservedArticleImage' });
    if (state.uploads.length === 2) state.images[0]!.category = 'DifferentNativeCategory';
  };
  await assert.rejects(run(), /MXP_MEDIA_STATE_UNSTABLE.*媒体类别发生变化/);
  assert.equal(page.uploads.length, 2);
});

test('timeout retains the pending upload; a late success is claimed once on explicit continuation', async t => {
  const { page, run, time, session } = setup(t, 2);
  let allowFirst = false;
  page.onUpload = state => { if (state.uploads.length === 2) state.images.push({ id: 'second', key: 'second-key', localId: 'second-local' }); };
  page.beforeRead = state => { if (allowFirst && !state.images.some(image => image.id === 'late-first')) state.images.unshift({ id: 'late-first', key: 'late-first-key', localId: 'late-first-local' }); };
  await assert.rejects(run(), /MXP_MEDIA_UPLOAD_TIMEOUT/);
  assert.equal(time.now(), 180_000);
  const pendingId = session.pending?.uploadId;
  assert.ok(pendingId);
  assert.equal(page.uploads.length, 1);
  allowFirst = true;
  const result = await run();
  assert.deepEqual(result.map(image => image.id), ['late-first', 'second']);
  assert.equal(page.uploads.length, 2);
  assert.equal(page.uploads.filter(upload => upload.id === pendingId).length, 1);
});

test('explicit not-submitted response clears pending and retries the file after the DOM blocker is resolved', async t => {
  const { page, run, session, time } = setup(t, 2);
  page.preflight = () => ({ state: 'not-submitted', reason: '请先关闭已有弹窗。' });
  await assert.rejects(run(), /图片尚未提交.*请先关闭已有弹窗.*再次继续上传/);
  assert.equal(session.pending, undefined);
  assert.equal(page.uploads.length, 0);
  assert.equal(page.tokens.size, 0);
  assert.equal(time.now(), 0, 'a proven pre-submission failure must not wait for an impossible upload');
  const preventedToken = page.attempts[0];
  page.preflight = undefined;
  assert.equal((await run()).length, 2);
  assert.equal(page.attempts.length, 3);
  assert.equal(page.uploads.length, 2);
  assert.ok(page.uploads.every(upload => upload.id !== preventedToken));
});

test('not-submitted on a later file preserves confirmed images and resumes from that file', async t => {
  const { page, run, session, files } = setup(t, 3);
  page.preflight = state => state.uploads.length === 1 ? { state: 'not-submitted', reason: '正文媒体菜单尚未就绪。' } : undefined;
  await assert.rejects(run(), /图片尚未提交/);
  assert.equal(session.pending, undefined);
  assert.equal(session.confirmed?.length, 1);
  assert.equal(page.uploads.length, 1);
  page.preflight = undefined;
  assert.equal((await run()).length, 3);
  assert.deepEqual(page.uploads.map(upload => upload.asset.name), files.map(file => file.name));
  assert.equal(page.attempts.length, 4);
});

test('an unknown submission response retains pending and never becomes permission to retransmit', async t => {
  const { page, run, session, time } = setup(t, 1);
  page.preflight = () => ({ state: 'unknown' });
  await assert.rejects(run(), /未得到确认/);
  const token = session.pending?.uploadId;
  assert.ok(token);
  page.preflight = undefined;
  await assert.rejects(run(), /MXP_MEDIA_UPLOAD_TIMEOUT/);
  assert.equal(time.now(), 180_000);
  assert.equal(session.pending?.uploadId, token);
  assert.equal(page.attempts.length, 1);
  assert.equal(page.uploads.length, 0);
});

test('a thrown bridge error saying not-submitted does not count as explicit proof', async t => {
  const { page, run, session } = setup(t, 1);
  page.preflight = () => { throw new Error('not-submitted: response transport failed'); };
  await assert.rejects(run(), /response transport failed/);
  const token = session.pending?.uploadId;
  assert.ok(token);
  page.preflight = undefined;
  await assert.rejects(run(), /MXP_MEDIA_UPLOAD_TIMEOUT/);
  assert.equal(session.pending?.uploadId, token);
  assert.equal(page.attempts.length, 1);
  assert.equal(page.uploads.length, 0);
});

test('a dropped submission reply never causes repeated transmission, even across several continuations and a reload', async t => {
  const { page, run, session } = setup(t, 1);
  page.onUpload = () => 'drop';
  await assert.rejects(run(), /reply lost/);
  const pending = session.pending?.uploadId;
  page.documentId = 'new-document';
  page.tokens.clear();
  await assert.rejects(run(), /MXP_MEDIA_UPLOAD_TIMEOUT/);
  await assert.rejects(run(), /MXP_MEDIA_UPLOAD_TIMEOUT/);
  assert.equal(page.uploads.length, 1);
  assert.equal(session.pending?.uploadId, pending);
  page.images = [{ id: 'late-after-reload', localId: 'late-local', key: 'rehydrated-key' }];
  const result = await run();
  assert.equal(result[0]?.id, 'late-after-reload');
  assert.equal(page.uploads.length, 1);
});

test('a rejected file handoff can still finish later and is observed without retransmission', async t => {
  const { page, run, time } = setup(t, 1);
  page.onUpload = () => 'reject';
  await assert.rejects(run(), /未得到确认/);
  page.beforeRead = state => { if (time.now() >= 1000) state.images = [{ id: 'late-rejected', key: 'late-key' }]; };
  assert.equal((await run())[0]?.id, 'late-rejected');
  assert.equal(page.uploads.length, 1);
});

test('a reported handoff rejection preserves pending and prevents the next file until explicit continuation', async t => {
  const { page, run, session } = setup(t, 2);
  let reject = true;
  page.onUpload = state => { state.images.push({ id: `media-${state.uploads.length}`, localId: `local-${state.uploads.length}`, key: `key-${state.uploads.length}` }); };
  page.beforeRead = (state, action) => { if (reject && action.uploadId) state.tokens.set(action.uploadId, 'rejected'); };
  await assert.rejects(run(), /图片提交操作报告失败/);
  assert.ok(session.pending);
  assert.equal(page.uploads.length, 1);
  reject = false;
  assert.equal((await run()).length, 2);
  assert.equal(page.uploads.length, 2);
});

test('page navigation interrupts an in-flight upload before another file is submitted', async t => {
  const { page, run, session } = setup(t);
  page.beforeRead = state => { if (state.uploads.length) state.articleId = '456'; };
  await assert.rejects(run(), PageChangedError);
  assert.equal(page.uploads.length, 1);
  assert.ok(session.pending);
});

test('session rejects changed article, source order, and file bytes before any additional browser work', async t => {
  const { page, run, files } = setup(t, 2);
  page.onUpload = () => 'drop';
  await assert.rejects(run(), /reply lost/);
  const reads = page.reads;
  await assert.rejects(run('456'), ResumeRejectedError);
  await assert.rejects(run('123', [...files].reverse()), ResumeRejectedError);
  await assert.rejects(run('123', files.map((file, index) => index === 0 ? { ...file, base64: 'modified bytes' } : file)), ResumeRejectedError);
  assert.equal(page.reads, reads);
  assert.equal(page.uploads.length, 1);
});

test('changed body or an inserted real paragraph stops continuation without resubmitting pending media', async t => {
  const { page, run } = setup(t, 1);
  page.onUpload = () => 'drop';
  await assert.rejects(run(), /reply lost/);
  page.body = 'User changed the text';
  await assert.rejects(run(), ResumeRejectedError);
  page.body = 'Private article body';
  page.middleBlank = true;
  await assert.rejects(run(), ResumeRejectedError);
  assert.equal(page.uploads.length, 1);
});

test('fresh sessions reject pre-existing media as external editing before any upload', async t => {
  const { page, run, session } = setup(t);
  page.images = [{ id: 'user-media', key: 'user-key' }];
  await assert.rejects(run(), ResumeRejectedError);
  assert.equal(page.uploads.length, 0);
  assert.equal(session.articleId, undefined);
});

test('brief editor remounts are re-read and cannot trigger an extra upload', async t => {
  const { page, run, time } = setup(t, 2);
  page.beforeRead = state => { state.unavailable = state.uploads.length === 1 && time.now() < 2000; };
  const result = await run();
  assert.equal(result.length, 2);
  assert.ok(page.uploads[1]!.at >= 2500);
  assert.equal(page.uploads.length, 2);
});

test('entity keys cannot stand in for lost stable identities after a document reload', async t => {
  const { page, run } = setup(t, 2);
  page.onUpload = state => {
    state.images.push({ id: `media-${state.uploads.length}`, key: `key-${state.uploads.length}` });
    if (state.uploads.length === 2) { state.documentId = 'reloaded'; state.images[0]!.id = 'unknown-promoted'; state.images[0]!.localId = null; }
  };
  await assert.rejects(run(), /旧图片丢失/);
  assert.equal(page.uploads.length, 2);
});

test('an unobserved local ID cannot replace lost identity when the document token is unavailable', async t => {
  const { page, run } = setup(t, 2);
  page.documentId = undefined;
  page.onUpload = state => {
    state.images.push({ id: `media-${state.uploads.length}`, key: `key-${state.uploads.length}` });
    if (state.uploads.length === 2) { state.images[0]!.id = 'different-id'; state.images[0]!.localId = '1'; }
  };
  await assert.rejects(run(), /旧图片丢失/);
});

test('duplicate local IDs are ignored instead of stealing another images unique media identity', async t => {
  const { page, run } = setup(t, 3);
  page.documentId = undefined;
  page.onUpload = state => {
    state.images.push({ id: `media-${state.uploads.length}`, localId: 'shared-native-local', key: `key-${state.uploads.length}` });
    if (state.uploads.length === 3) state.images[0]!.id = 'unknown-old-id';
  };
  await assert.rejects(run(), /旧图片丢失/);
  assert.equal(page.uploads.length, 3, 'first two are identified by unique media IDs, but the third cannot repair a lost ID using a duplicate local ID');
});

test('a permanently missing editor has a bounded wait, retains pending, and reports recovery state without retransmission', async t => {
  const { page, run, session, time, events } = setup(t, 2);
  page.beforeRead = state => { state.unavailable = state.uploads.length > 0; };
  await assert.rejects(run(), /MXP_MEDIA_STATE_UNSTABLE/);
  assert.equal(time.now(), 180_000);
  assert.equal(page.uploads.length, 1);
  assert.ok(session.pending);
  assert.equal(events.filter(event => event.details?.state === 'editor_unavailable').length, 17);
});

test('slow progress and diagnostics contain only state and counts, never body, paths, tokens, or media IDs', async t => {
  const { page, run, time, messages, events, files, session } = setup(t, 1);
  page.onUpload = () => undefined;
  page.beforeRead = state => { if (time.now() >= 25_000) state.images = [{ id: 'private-result-id', localId: 'private-result-local', key: 'private-result-key' }]; };
  await run();
  const output = JSON.stringify({ messages, events });
  for (const secret of ['Private article body', 'Private title', 'private-result-id', 'private-result-local', 'private-result-key', 'document-a', ...files.flatMap(file => [file.source, file.name, file.base64]), page.uploads[0]!.id, session.assetsFingerprint!]) assert.ok(!output.includes(secret), `must omit ${secret}`);
  const slow = events.filter(event => event.event === 'media_upload_waiting');
  assert.deepEqual(slow.map(event => event.details?.elapsedSeconds), [10, 20]);
  assert.ok(messages.length >= 3);
});

test('a completed upload session revalidates identities and never uploads a file again', async t => {
  const { page, run } = setup(t, 2);
  await run();
  page.images = page.images.map(image => ({ ...image, key: `recreated-${image.key}` }));
  assert.equal((await run()).length, 2);
  assert.equal(page.uploads.length, 2);
  page.images.pop();
  await assert.rejects(run(), /旧图片丢失/);
  assert.equal(page.uploads.length, 2);
});
