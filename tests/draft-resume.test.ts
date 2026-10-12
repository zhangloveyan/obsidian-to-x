import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { BrowserBridge, DraftRequest, XContent } from '../src/model';
import { serializeContent } from '../src/content/article';
import { saveDraft, type DraftSaveSession } from '../src/browser/x-draft';

function fastPolling(t: TestContext): void {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay = 0) => { now += delay; queueMicrotask(callback); return 0; }) as unknown as typeof setTimeout);
}

function resumableBrowser(options: { failTitle?: boolean; pendingTransportFailure?: boolean; seedResponseFailure?: boolean; seedNotSaved?: boolean; contentResponseFailure?: boolean } = {}) {
  const request: DraftRequest = {
    title: 'Continue this article',
    blocks: [{ type: 'text', kind: 'unstyled', text: 'Body with a photo', styles: [], links: [] }, { type: 'image', source: 'photo.png', alt: '' }],
    images: [{ source: 'photo.png', name: 'photo.png', mime: 'image/png', base64: 'aW1hZ2U=' }],
  };
  const image = { source: 'photo.png', id: 'saved-photo', localId: 'local-photo', entityKey: 'image-0', category: 'DraftTweetImage' };
  const activity: string[] = [];
  let titleFailed = false;
  let seedFailed = false;
  let finalFailed = false;
  let uploadCount = 0;
  let uploadsVisible = false;
  let title = '';
  let seed = serializeContent([], new Map());
  let finalContent: XContent | undefined;
  let contentWrites = 0;
  let finalReads = 0;
  let reloads = 0;
  let away = false;
  let userEdited = false;
  const bridge: BrowserBridge = {
    async call(name, args) {
      activity.push(`${name}:${args.url ?? args.action ?? ''}`);
      if (name === 'browser_navigate' && String(args.url).includes('/edit/')) reloads++;
      return { content: [{ type: 'text', text: '- 0: (current) [X](https://x.com/home)' }] };
    },
    async evaluate<T>(expression: string): Promise<T> {
      const action = JSON.parse(expression.slice(expression.lastIndexOf(')(') + 2, -1)) as { kind?: string; id?: string; uploadId?: string; operation?: string; variables?: Record<string, unknown> };
      activity.push(action.kind ?? action.operation!);
      if (away) throw new Error('MXP_PAGE_CHANGED: 浏览器已离开本次草稿，操作已停止。');
      if (action.kind === 'create') return { previous: [] } as T;
      if (action.kind === 'toast' || action.kind === 'focus') return true as T;
      if (action.kind === 'upload') {
        uploadCount++;
        if (options.pendingTransportFailure && uploadCount === 1) throw new Error('Upload response connection lost');
        uploadsVisible = true;
        return { state: 'submitted' } as T;
      }
      if (action.operation === 'ArticleEntityUpdateTitle') {
        if (options.failTitle && !titleFailed) { titleFailed = true; return { status: 503, body: null } as T; }
        title = String(action.variables!.title);
        return { status: 200, body: { data: { saved: true } } } as T;
      }
      if (action.operation === 'ArticleEntityUpdateContent') {
        contentWrites++;
        if (!uploadCount) {
          if (!options.seedNotSaved || seedFailed) seed = structuredClone(action.variables!.content_state as XContent);
          if (options.seedResponseFailure && !seedFailed) { seedFailed = true; return { status: 503, body: null } as T; }
        } else {
          finalContent = structuredClone(action.variables!.content_state as XContent);
          if (options.contentResponseFailure && !finalFailed) { finalFailed = true; return { status: 503, body: null } as T; }
        }
        return { status: 200, body: { data: { saved: true } } } as T;
      }
      const current = structuredClone(finalContent ?? seed);
      if (!finalContent && uploadsVisible) {
        current.blocks.push({ key: 'photo', type: 'atomic', text: ' ', data: {}, inline_style_ranges: [], entity_ranges: [{ key: 100, offset: 0, length: 1 }] });
        current.entity_map.push({ key: '100', value: { type: 'MEDIA', mutability: 'IMMUTABLE', data: { mediaItems: [{ mediaId: image.id, localMediaId: image.localId, mediaCategory: image.category }] } } });
      }
      if (userEdited) current.blocks.push({ key: 'user-edit', type: 'unstyled', text: 'My new text in X', data: {}, inline_style_ranges: [], entity_ranges: [] });
      if (finalContent) finalReads++;
      return { id: '123', url: 'https://x.com/compose/articles/edit/123', documentId: `doc-${reloads}`, titleInputs: [title], saved: { title, cover: null, media: uploadsVisible ? [image.id] : [] }, content: current, ...(action.uploadId ? { upload: { state: 'submitted' } } : {}) } as T;
    },
    async close() { throw new Error('The caller owns the connection'); },
  };
  return { bridge, request, activity, finalReads: () => finalReads, uploads: () => uploadCount, contentWrites: () => contentWrites, finishPending: () => { uploadsVisible = true; }, leavePage: () => { away = true; }, editBody: () => { userEdited = true; } };
}

test('uncertain native upload continues in the same draft without resubmitting the file', async t => {
  fastPolling(t);
  const run = resumableBrowser({ pendingTransportFailure: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session));
  assert.equal(session.resumable, true);
  assert.ok(session.mediaUpload?.pending);
  const previous = run.activity.length;
  run.finishPending();
  const result = await saveDraft(run.bridge, run.request, () => undefined, undefined, session);
  assert.equal(result.id, '123');
  assert.equal(run.activity[previous], 'read');
  assert.equal(run.activity.filter(item => item === 'create').length, 1);
  assert.equal(run.uploads(), 1);
  assert.equal(run.activity.filter(item => item === 'focus').length, 1, 'continuation keeps the existing native insertion state');
  assert.equal(session.resumable, false);
});

test('failed final writes continue the same draft and reuse refreshed media identities', async t => {
  fastPolling(t);
  const run = resumableBrowser({ failTitle: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /保存进度已保留，可继续当前草稿/);
  assert.equal(session.draft?.id, '123');
  assert.ok(session.mediaUpload?.result);
  assert.ok(session.media);
  assert.equal(session.resumable, true);
  const retryStart = run.activity.length;
  assert.equal((await saveDraft(run.bridge, run.request, () => undefined, undefined, session)).id, '123');
  assert.equal(run.activity[retryStart], 'read');
  assert.equal(run.activity.filter(item => item === 'create').length, 1);
  assert.equal(run.uploads(), 1);
  assert.equal(run.activity.filter(item => item === 'browser_navigate:https://x.com/compose/articles').length, 1);
  assert.ok(run.finalReads() >= 2);
  assert.equal(session.resumable, false);
});

test('changed article, image or cover rejects continuation before any browser operation', async t => {
  fastPolling(t);
  const run = resumableBrowser({ failTitle: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session));
  for (const change of [
    (request: DraftRequest) => { request.title = 'Changed'; },
    (request: DraftRequest) => { request.images[0]!.base64 = 'Y2hhbmdlZA=='; },
    (request: DraftRequest) => { request.cover = request.images[0]; },
  ]) {
    const request = structuredClone(run.request);
    change(request);
    const previous = run.activity.length;
    await assert.rejects(() => saveDraft(run.bridge, request, () => undefined, undefined, session), /文章、图片或封面已改变/);
    assert.equal(run.activity.length, previous);
    assert.equal(session.resumable, false);
  }
});

test('continuation never navigates or writes when the browser left the saved draft', async t => {
  fastPolling(t);
  const run = resumableBrowser({ failTitle: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session));
  run.leavePage();
  const previous = run.activity.length;
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /浏览器已离开本次草稿/);
  assert.deepEqual(run.activity.slice(previous), ['read']);
  assert.equal(session.resumable, true);
});

test('completed uploads cannot overwrite body edits made after a failure', async t => {
  fastPolling(t);
  const run = resumableBrowser({ failTitle: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session));
  run.editBody();
  const previous = run.activity.length;
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /X 草稿正文已改变或无法核对/);
  assert.deepEqual(run.activity.slice(previous), ['read']);
  assert.equal(session.resumable, false);
});

test('completed media without a verifiable body snapshot cannot continue', async t => {
  fastPolling(t);
  const run = resumableBrowser({ failTitle: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session));
  delete session.knownContent;
  delete session.submittedContent;
  const previous = run.activity.length;
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /请先检查草稿后另存/);
  assert.deepEqual(run.activity.slice(previous), ['read']);
  assert.equal(session.resumable, false);
});

test('continuation accepts a submitted final body when its mutation response was lost', async t => {
  fastPolling(t);
  const run = resumableBrowser({ contentResponseFailure: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /保存正文失败/);
  assert.ok(session.knownContent);
  assert.ok(session.submittedContent);
  assert.equal((await saveDraft(run.bridge, run.request, () => undefined, undefined, session)).id, '123');
  assert.equal(run.activity.filter(item => item === 'create').length, 1);
  assert.equal(run.uploads(), 1);
  assert.equal(session.resumable, false);
});

test('lost seed mutation response is verified after reload without repeating the seed write', async t => {
  fastPolling(t);
  const run = resumableBrowser({ seedResponseFailure: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /保存正文失败/);
  assert.equal(run.uploads(), 0);
  assert.equal(session.resumable, true);
  assert.ok(session.seedContent);
  assert.equal((await saveDraft(run.bridge, run.request, () => undefined, undefined, session)).id, '123');
  assert.equal(run.contentWrites(), 2, 'one seed and one final content mutation');
  assert.equal(run.uploads(), 1);
});

test('changed body after a lost seed response is rejected before navigation or another write', async t => {
  fastPolling(t);
  const run = resumableBrowser({ seedResponseFailure: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session));
  run.editBody();
  const previous = run.activity.length;
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /X 草稿正文已改变或无法核对/);
  assert.deepEqual(run.activity.slice(previous), ['read']);
  assert.equal(run.uploads(), 0);
  assert.equal(run.contentWrites(), 1);
});

test('a failed seed save can retry only while the original draft remains empty', async t => {
  fastPolling(t);
  const run = resumableBrowser({ seedResponseFailure: true, seedNotSaved: true });
  const session: DraftSaveSession = {};
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /保存正文失败/);
  assert.equal(run.uploads(), 0);
  assert.equal((await saveDraft(run.bridge, run.request, () => undefined, undefined, session)).id, '123');
  assert.equal(run.contentWrites(), 3, 'the rejected seed, safe seed retry and final body');
  assert.equal(run.uploads(), 1);
});

test('an existing draft without saved progress cannot be replayed', async t => {
  fastPolling(t);
  const run = resumableBrowser();
  const session: DraftSaveSession = { draft: { id: '123', url: 'https://x.com/compose/articles/edit/123' } };
  await assert.rejects(() => saveDraft(run.bridge, run.request, () => undefined, undefined, session), /没有可继续的保存进度/);
  assert.deepEqual(run.activity, ['read']);
});
