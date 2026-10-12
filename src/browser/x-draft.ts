import { createHash } from 'node:crypto';
import { serializeContent } from '../content/article';
import type { BrowserBridge, DiagnosticSink, DraftRequest, DraftResult, MediaAsset, Progress, UploadedMedia, XContent } from '../model';
import { DraftMediaPendingError, openArticleList, PageChangedError, PageOperationError, ResumeRejectedError, runPage, verifyInjectedMedia, waitFor } from './x-page';
import { uploadArticleMedia, verifyUploadBody, type MediaUploadSession } from './media-upload';
import { verifyContent, verifyDraft, verifyMutation } from './x-protocol';
import type { DraftSnapshot } from './x-protocol';

// X's internal web operations are not a public API. Reload verification below
// is mandatory: a successful HTTP response alone is never a successful save.
const operations = {
  title: { name: 'ArticleEntityUpdateTitle', id: 'x75E2ABzm8_mGTg1bz8hcA', label: '保存标题' },
  content: { name: 'ArticleEntityUpdateContent', id: 'M7N2FrPrlOmu-YrVIBxFnQ', label: '保存正文' },
  cover: { name: 'ArticleEntityUpdateCoverMedia', id: 'Es8InPh7mEkK9PxclxFAVQ', label: '保存封面' },
};

interface MutationInput { article: string; operation: string; query: string; variables: Record<string, unknown>; }

/** In-memory progress for one article and one draft; never persisted with credentials. */
export interface DraftSaveSession {
  fingerprint?: string;
  draft?: DraftResult;
  mediaUpload?: MediaUploadSession;
  seedContent?: XContent;
  seeded?: boolean;
  media?: Array<UploadedMedia & { source: string; localIdIsFallback?: boolean }>;
  resumable?: boolean;
  knownContent?: XContent;
  submittedContent?: XContent;
}

function rememberContent(snapshot: DraftSnapshot): XContent {
  const content = snapshot.content as XContent;
  verifyContent(content, content);
  return structuredClone(content);
}

function assertUnchangedContent(snapshot: DraftSnapshot, session: DraftSaveSession): void {
  for (const expected of [session.knownContent, session.submittedContent]) {
    if (!expected) continue;
    try { verifyContent(expected, snapshot.content); return; } catch { /* Try a content mutation whose response may have been lost. */ }
  }
  throw new ResumeRejectedError('X 草稿正文已改变或无法核对，已停止继续保存以保护当前内容；请先检查草稿后另存。');
}

async function webMutation(input: MutationInput): Promise<unknown> {
  if (location.hostname !== 'x.com' || !location.pathname.endsWith(`/articles/edit/${input.article}`)) throw new Error('页面已离开本次草稿，保存已停止。');
  const csrf = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('ct0='))?.slice(4);
  if (!csrf) throw new Error('未读取到 X 登录会话，请先在 Chrome 登录 X。');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25_000);
  try {
    const response = await fetch(`/i/api/graphql/${input.query}/${input.operation}`, {
      method: 'POST', credentials: 'include', signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        // Public X web-client bearer value; the user's session stays in Chrome.
        Authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      },
      body: JSON.stringify({
        queryId: input.query,
        variables: input.variables,
        features: {
          profile_label_improvements_pcf_label_in_post_enabled: true,
          responsive_web_profile_redirect_enabled: false,
          rweb_tipjar_consumption_enabled: false,
          verified_phone_label_enabled: false,
          responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
          responsive_web_graphql_timeline_navigation_enabled: true,
        },
      }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally { clearTimeout(timer); }
}

async function mutate(bridge: BrowserBridge, article: string, kind: keyof typeof operations, variables: Record<string, unknown>, diagnostic: DiagnosticSink): Promise<void> {
  const operation = operations[kind];
  const input: MutationInput = { article, operation: operation.name, query: operation.id, variables };
  const started = Date.now();
  let result: unknown;
  try {
    result = await bridge.evaluate<unknown>(`(${webMutation.toString()})(${JSON.stringify(input)})`);
  } catch (error) {
    diagnostic('mutation-transport-failed', { operation: operation.name, durationMs: Date.now() - started });
    throw error;
  }
  const response = result as { status?: unknown; body?: { errors?: unknown } | null } | null;
  const errors = response?.body?.errors;
  diagnostic('mutation-result', { operation: operation.name, durationMs: Date.now() - started, httpStatus: typeof response?.status === 'number' ? response.status : null, graphqlErrors: Array.isArray(errors) ? errors.length : errors === undefined || errors === null ? 0 : 1 });
  verifyMutation(result, operation.label);
}

function requestedAssets(request: DraftRequest): MediaAsset[] {
  if (!request.title.trim()) throw new Error('文章标题不能为空。');
  if (!request.blocks.length) throw new Error('文章正文不能为空。');
  const bySource = new Map<string, MediaAsset>();
  for (const asset of [...request.images, ...(request.cover ? [request.cover] : [])]) {
    const previous = bySource.get(asset.source);
    if (previous && (previous.base64 !== asset.base64 || previous.mime !== asset.mime)) throw new Error(`同一来源的图片数据不一致：${asset.source}`);
    bySource.set(asset.source, asset);
  }
  const sources = new Set(request.blocks.flatMap(block => block.type === 'image' ? [block.source] : []));
  const result: MediaAsset[] = [];
  for (const source of sources) {
    const asset = bySource.get(source);
    if (!asset) throw new Error(`没有读取到正文图片：${source}`);
    result.push(asset);
  }
  if (request.cover && !sources.has(request.cover.source)) result.push(request.cover);
  for (const asset of result) {
    if (!asset.base64 || !asset.mime.startsWith('image/') || !asset.name) throw new Error(`图片数据无效：${asset.source}`);
  }
  return result;
}

function assertEmptyDraft(snapshot: DraftSnapshot): void {
  if (!snapshot.saved || snapshot.saved.title || snapshot.saved.cover || snapshot.saved.media.length) throw new Error('新建入口没有返回空白草稿，已停止以保护已有内容。');
  const content = snapshot.content as { blocks?: Array<{ type: string; text: string; entity_ranges: unknown[] }> } | null;
  if (!content?.blocks?.length || content.blocks.some(block => block.type !== 'unstyled' || block.text !== '' || block.entity_ranges.length)) throw new Error('新建草稿不是空白内容，已停止保存。');
}

async function reloadDraft(bridge: BrowserBridge, draft: DraftResult, verify?: (snapshot: DraftSnapshot) => void): Promise<DraftSnapshot> {
  await runPage(bridge, { kind: 'read', id: draft.id });
  await bridge.call('browser_navigate', { url: draft.url });
  return waitFor('等待草稿重新加载', async () => {
    const snapshot = await runPage<DraftSnapshot>(bridge, { kind: 'read', id: draft.id });
    if (snapshot.id !== draft.id) throw new PageChangedError();
    if (!snapshot.saved || !snapshot.content) return null;
    try {
      verify?.(snapshot);
    } catch (error) {
      // Only missing image hydration/binding is transient. Identity conflicts,
      // extra images and malformed content must stop before final mutations.
      if (error instanceof DraftMediaPendingError || error instanceof ResumeRejectedError) throw error;
      throw new PageOperationError(error instanceof Error ? error.message : String(error));
    }
    return snapshot;
  });
}

/** Save or continue one draft. The caller owns the MCP connection and session. */
export async function saveDraft(bridge: BrowserBridge, request: DraftRequest, progress: Progress, diagnostic?: DiagnosticSink, session: DraftSaveSession = {}): Promise<DraftResult> {
  let draft = session.draft;
  const started = Date.now();
  let phase = 'validate';
  const note: DiagnosticSink = (event, details) => { try { diagnostic?.(event, { stage: phase, ...details }); } catch { /* Diagnostics must never change the save result. */ } };
  const stage = (value: string) => { phase = value; note('stage', { stage: value, elapsedMs: Date.now() - started }); };
  const describe = (snapshot: DraftSnapshot) => {
    const content = snapshot.content as { entity_map?: Array<{ value: { type: string } }> } | null;
    note('draft-state', { stage: phase, editorReady: snapshot.content !== null, savedRecordReady: snapshot.saved !== null, editorImages: content?.entity_map?.filter(entity => entity.value.type === 'MEDIA').length ?? 0, boundImages: snapshot.saved?.media.length ?? 0 });
  };
  try {
    stage('validate');
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    if (session.fingerprint && session.fingerprint !== fingerprint) throw new ResumeRejectedError('文章、图片或封面已改变，不能继续原草稿；请重新预览后另存新草稿。');
    const assets = requestedAssets(request);
    // Validate formatting before creating anything in the user's account.
    serializeContent(request.blocks, new Map(assets.map(asset => [asset.source, { id: 'pending', localId: 'pending', category: 'DraftTweetImage' }])));
    session.fingerprint = fingerprint;
    if (draft) {
      stage('resume-draft');
      // Probe the currently controlled page before doing anything else. Never
      // navigate back or replace another tab's content during a continuation.
      const current = await runPage<DraftSnapshot>(bridge, { kind: 'read', id: draft.id });
      if (current.id !== draft.id) throw new PageChangedError();
      if (!session.resumable || (!session.seedContent && !session.mediaUpload)) throw new ResumeRejectedError('当前草稿没有可继续的保存进度，请先检查草稿后另存。');
      if (session.media || !session.mediaUpload) assertUnchangedContent(current, session);
      progress('正在继续当前 X 草稿…');
      describe(current);
    } else {
      stage('open-article-list');
      progress('正在打开 X 文章列表…');
      await openArticleList(bridge);
      stage('create-draft');
      const created = await waitFor('等待新建文章入口', () => runPage<{ previous: string[] }>(bridge, { kind: 'create' }));
      const empty = await waitFor('等待新草稿编辑器', async () => {
        const snapshot = await runPage<DraftSnapshot>(bridge, { kind: 'read', ...(draft ? { id: draft.id } : {}) });
        if (draft && snapshot.id !== draft.id) throw new PageChangedError();
        if (snapshot.id && !draft) {
          draft = { id: snapshot.id, url: `https://x.com/compose/articles/edit/${snapshot.id}` };
          session.draft = draft;
        }
        if (!snapshot.id && new URL(snapshot.url).pathname !== '/compose/articles') throw new PageChangedError();
        return snapshot.id && snapshot.content && snapshot.saved ? snapshot : null;
      });
      draft = session.draft;
      if (!draft) throw new Error('没有读取到新草稿地址。');
      if (created.previous.includes(draft.id)) throw new Error('新建入口打开了已有草稿，已停止保存。');
      assertEmptyDraft(empty);
      session.knownContent = rememberContent(empty);
      describe(empty);
    }
    stage('write-editor');
    let media = new Map<string, UploadedMedia>();
    if (assets.length) {
      if (!session.seeded) {
        stage('prepare-editor');
        progress('正在保存上传前的正文…');
        const seed = serializeContent(request.blocks.filter(block => block.type !== 'image'), new Map());
        if (!session.seedContent) {
          session.seedContent = structuredClone(seed);
          session.submittedContent = structuredClone(seed);
          let alreadyEmpty = false;
          if (session.knownContent) {
            try { verifyContent(seed, session.knownContent); alreadyEmpty = true; } catch { /* The article has text to prepare. */ }
          }
          if (!alreadyEmpty) await mutate(bridge, draft.id, 'content', { article_entity: draft.id, content_state: seed }, note);
        } else {
          const current = await runPage<DraftSnapshot>(bridge, { kind: 'read', id: draft.id });
          assertUnchangedContent(current, session);
          let alreadySaved = false;
          try { verifyContent(seed, current.content); alreadySaved = true; } catch { /* The first request may have failed before saving. */ }
          if (!alreadySaved) {
            // Retrying the initial save is safe only while the original draft
            // is still entirely empty and no native upload has started.
            assertEmptyDraft(current);
            await mutate(bridge, draft.id, 'content', { article_entity: draft.id, content_state: seed }, note);
          }
        }
        // Read after reload even when an uncertain response already produced
        // the desired body in the live editor.
        const prepared = await reloadDraft(bridge, draft);
        await waitFor('核验上传前正文', async () => {
          const snapshot = await runPage<DraftSnapshot>(bridge, { kind: 'read', id: draft!.id });
          verifyContent(seed, snapshot.content);
          session.knownContent = rememberContent(snapshot);
          return true;
        });
        describe(prepared);
        session.seeded = true;
        session.submittedContent = undefined;
      }
      if (session.media) media = new Map(session.media.map(image => [image.source, image]));
      else {
        if (!session.seedContent) throw new ResumeRejectedError('缺少已核验的上传前正文，不能继续保存。');
        if (!session.mediaUpload) {
          await runPage(bridge, { kind: 'focus', id: draft.id });
          await bridge.call('browser_press_key', { key: process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End' });
          const focused = await runPage<DraftSnapshot>(bridge, { kind: 'read', id: draft.id });
          verifyContent(session.seedContent, focused.content);
        }
        stage('upload-images');
        const uploaded = await uploadArticleMedia(bridge, draft.id, assets, progress, note, session.mediaUpload ??= {});
        session.knownContent = rememberContent(await runPage<DraftSnapshot>(bridge, { kind: 'read', id: draft.id }));
        stage('verify-editor-save');
        progress('正在刷新并核对正文图片…');
        const reloaded = await reloadDraft(bridge, draft, snapshot => {
          media = verifyInjectedMedia(snapshot, uploaded);
          verifyUploadBody(snapshot.content, session.seedContent!);
        });
        session.knownContent = rememberContent(reloaded);
        session.media = [...media].map(([source, image]) => ({ ...image, source }));
        describe(reloaded);
        note('editor-save-verified', { images: uploaded.length });
      }
    }
    const content = serializeContent(request.blocks, media);
    const cover = request.cover ? media.get(request.cover.source) : undefined;
    if (request.cover && !cover) throw new Error('封面上传结果缺失。');
    progress('正在保存标题、正文和封面…');
    stage('save-title');
    await mutate(bridge, draft.id, 'title', { articleEntityId: draft.id, title: request.title }, note);
    stage('save-content');
    session.submittedContent = structuredClone(content);
    await mutate(bridge, draft.id, 'content', { article_entity: draft.id, content_state: content }, note);
    if (cover) {
      stage('save-cover');
      await mutate(bridge, draft.id, 'cover', { articleEntityId: draft.id, coverMedia: { media_id: cover.id, media_category: cover.category } }, note);
    }
    stage('verify-draft');
    progress('正在刷新并核对完整草稿…');
    describe(await reloadDraft(bridge, draft));
    await waitFor('核验已保存草稿', async () => {
      const snapshot = await runPage<DraftSnapshot>(bridge, { kind: 'read', id: draft!.id });
      if (snapshot.id !== draft!.id) throw new PageChangedError();
      verifyDraft(snapshot, draft!.id, request.title, content, cover?.id ?? null);
      return true;
    });
    // A cosmetic notification must not invalidate an already verified save.
    await runPage(bridge, { kind: 'toast', id: draft.id }).catch(() => undefined);
    stage('complete');
    session.resumable = false;
    progress('草稿已保存并核对。');
    return draft;
  } catch (error) {
    session.resumable = !(error instanceof ResumeRejectedError) && Boolean(session.seedContent || session.mediaUpload);
    const detail = error instanceof Error ? error.message : String(error);
    note('failure', { stage: phase, elapsedMs: Date.now() - started, code: error instanceof PageChangedError ? 'page-changed' : 'save-failed', draftCreated: draft !== undefined });
    throw new Error(`${detail}${draft ? session.resumable
      ? `\n保存进度已保留，可继续当前草稿：${draft.url}`
      : `\n已创建的草稿可在此恢复，请先检查后再重试：${draft.url}` : ''}`);
  }
}
