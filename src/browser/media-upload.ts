import { createHash, randomUUID } from 'node:crypto';
import type { BrowserBridge, DiagnosticSink, MediaAsset, Progress, UploadedMedia, XContent } from '../model';
import { PageChangedError, ResumeRejectedError, runPage } from './x-page';
import { verifyContent, type DraftSnapshot } from './x-protocol';

type MediaResult = UploadedMedia & { source: string; localIdIsFallback?: boolean };
interface ObservedMedia {
  id: string | null;
  localId: string;
  localIdIsFallback: boolean;
  category: string;
  entityKey: string;
}
interface Identity {
  source?: string;
  current: UploadedMedia & { localIdIsFallback: boolean };
  ids: string[];
  localIds: string[];
  entityKeys: Array<{ documentId: string; key: string }>;
}
interface PendingUpload {
  source: string;
  uploadId: string;
  before: Identity[];
  candidate?: Identity;
  interrupted: boolean;
}

/** Keep this object for an explicit retry after a browser or upload interruption. */
export interface MediaUploadSession {
  articleId?: string;
  assetsFingerprint?: string;
  body?: XContent;
  confirmed?: Identity[];
  pending?: PendingUpload;
  result?: MediaResult[];
  active?: boolean;
}

const TIMEOUT = 180_000;
const INTERVAL = 500;
const REPORT_INTERVAL = 10_000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图片快照格式无效，操作已停止。');
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string | null {
  return (typeof value === 'string' || typeof value === 'number') && String(value) !== '' ? String(value) : null;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('图片快照列表缺失，操作已停止。');
  return value;
}

/** Read only serialized editor data; never infer identities from block order. */
function inspect(content: unknown): { body: XContent; media: ObservedMedia[] } {
  const raw = record(content);
  const entries = array(raw.entity_map).map(record);
  const mediaKeys = new Set<string>();
  const allKeys = new Set<string>();
  const media: ObservedMedia[] = [];
  for (const entry of entries) {
    const key = identifier(entry.key);
    if (!key || allKeys.has(key)) throw new Error('图片实体键缺失或重复，操作已停止。');
    allKeys.add(key);
    const entity = record(entry.value);
    if (entity.type !== 'MEDIA') continue;
    mediaKeys.add(key);
    const data = record(entity.data);
    const items = data.mediaItems ?? data.media_items;
    // An empty MEDIA entity still occupies an upload slot, but is not ready.
    const values = items === undefined || items === null || (Array.isArray(items) && items.length === 0) ? [{}] : array(items);
    for (const value of values) {
      const item = record(value);
      const localId = identifier(item.localMediaId ?? item.local_media_id);
      media.push({
        id: identifier(item.mediaId ?? item.media_id),
        localId: localId ?? '', localIdIsFallback: localId === null,
        category: identifier(item.mediaCategory ?? item.media_category) ?? '',
        entityKey: key,
      });
    }
  }
  const referenced = new Set<string>();
  const blocks = array(raw.blocks).filter(value => {
    const block = record(value);
    const ranges = array(block.entity_ranges).map(record);
    const images = ranges.filter(range => mediaKeys.has(String(range.key)));
    if (!images.length) return true;
    if (block.type !== 'atomic' || (block.text !== ' ' && block.text !== '') || images.length !== ranges.length || array(block.inline_style_ranges).length) {
      throw new ResumeRejectedError('图片段落包含无法安全分离的正文，操作已停止。');
    }
    for (const range of images) {
      const key = String(range.key);
      if (referenced.has(key)) throw new Error('图片实体被重复引用，操作已停止。');
      referenced.add(key);
    }
    return false;
  });
  if (referenced.size !== mediaKeys.size) throw new Error('图片包含未引用实体，操作已停止。');
  // Preserve every actual text block, including empty paragraphs in the middle.
  // verifyContent already ignores Draft's trailing empty caret paragraphs.
  if (!blocks.length) blocks.push({ key: 'empty', type: 'unstyled', text: '', data: {}, entity_ranges: [], inline_style_ranges: [] });
  const body = { blocks, entity_map: entries.filter(entry => !mediaKeys.has(String(entry.key))) } as unknown as XContent;
  verifyContent(body, body);
  return { body, media };
}

function assertPage(snapshot: DraftSnapshot, articleId: string): void {
  let url: URL;
  try { url = new URL(snapshot.url); } catch { throw new PageChangedError(); }
  if (snapshot.id !== articleId || url.hostname !== 'x.com' || url.pathname.match(/\/articles\/edit\/(\d+)\/?$/)?.[1] !== articleId) throw new PageChangedError();
}

function checkBody(session: MediaUploadSession, body: XContent): void {
  if (!session.body) return;
  try { verifyContent(session.body, body); }
  catch { throw new ResumeRejectedError('当前草稿正文已变化，不能继续此前的图片上传。'); }
}

/** Recheck the non-media body after a reload before writing canonical content. */
export function verifyUploadBody(content: unknown, expected: XContent): void {
  const body = inspect(content).body;
  try { verifyContent(expected, body); }
  catch { throw new ResumeRejectedError('刷新后的草稿正文已变化，已停止保存以保护当前内容。'); }
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

/** Missing fields may inherit only from this uniquely matched native identity. */
function knownMetadata(media: ObservedMedia, previous: Identity['current']): ObservedMedia {
  const localId = media.localIdIsFallback ? (previous.localIdIsFallback ? '' : previous.localId) : media.localId;
  return { ...media, localId, localIdIsFallback: !localId, category: media.category || previous.category };
}

function observe(identity: Identity, media: ObservedMedia, documentId: string | undefined): void {
  const known = knownMetadata(media, identity.current);
  if (media.id) {
    identity.current = { id: media.id, localId: known.localId, localIdIsFallback: known.localIdIsFallback, category: known.category, entityKey: media.entityKey };
    addUnique(identity.ids, media.id);
  } else {
    identity.current = { ...identity.current, localId: known.localId, localIdIsFallback: known.localIdIsFallback, category: known.category, entityKey: media.entityKey };
  }
  if (!media.localIdIsFallback) addUnique(identity.localIds, media.localId);
  if (documentId && !identity.entityKeys.some(alias => alias.documentId === documentId && alias.key === media.entityKey)) identity.entityKeys.push({ documentId, key: media.entityKey });
}

function identity(media: ObservedMedia, documentId: string | undefined, source?: string): Identity {
  if (!media.id) throw new Error('图片尚未取得上传 ID。');
  const result: Identity = { source, current: { id: media.id, localId: media.localId, localIdIsFallback: media.localIdIsFallback, category: media.category, entityKey: media.entityKey }, ids: [], localIds: [], entityKeys: [] };
  observe(result, media, documentId);
  return result;
}

function cloneIdentities(values: Identity[]): Identity[] {
  return values.map(value => ({ ...value, current: { ...value.current }, ids: [...value.ids], localIds: [...value.localIds], entityKeys: value.entityKeys.map(alias => ({ ...alias })) }));
}

/** Each matching field must be unique in both complete sets, including aliases. */
function reconcile(previous: Identity[], current: ObservedMedia[], documentId: string | undefined): { matched: Map<Identity, ObservedMedia>; extra: ObservedMedia[] } {
  const matched = new Map<Identity, ObservedMedia>();
  const extra: ObservedMedia[] = [];
  for (const media of current) {
    const candidates = new Set<Identity>();
    const fields: Array<{ value: string | null; current: (image: ObservedMedia) => string | null; previous: (image: Identity) => boolean }> = [
      { value: media.id, current: image => image.id, previous: image => media.id !== null && image.ids.includes(media.id) },
      { value: media.localIdIsFallback ? null : media.localId, current: image => image.localIdIsFallback ? null : image.localId, previous: image => image.localIds.includes(media.localId) },
      { value: documentId ? media.entityKey : null, current: image => image.entityKey, previous: image => image.entityKeys.some(alias => alias.documentId === documentId && alias.key === media.entityKey) },
    ];
    for (const field of fields) {
      if (!field.value || current.filter(image => field.current(image) === field.value).length !== 1) continue;
      const owners = previous.filter(field.previous);
      if (owners.length === 1 && owners[0]) candidates.add(owners[0]);
    }
    if (candidates.size > 1) throw new Error('MXP_MEDIA_IDENTITY_AMBIGUOUS: 图片身份字段指向不同来源，操作已停止。');
    const owner = candidates.values().next().value as Identity | undefined;
    if (!owner) { extra.push(media); continue; }
    if (matched.has(owner)) throw new Error('MXP_MEDIA_IDENTITY_AMBIGUOUS: 多张图片对应同一历史身份，操作已停止。');
    if (owner.current.category && media.category && owner.current.category !== media.category) throw new Error('MXP_MEDIA_STATE_UNSTABLE: 图片媒体类别发生变化，操作已停止。');
    matched.set(owner, media);
  }
  if (matched.size !== previous.length) throw new Error('MXP_MEDIA_IDENTITY_AMBIGUOUS: 旧图片丢失或无法唯一对应，已停止后续上传。');
  return { matched, extra };
}

function counts(snapshot: DraftSnapshot, media: ObservedMedia[]): { observed: number; bound: number; pending: number } {
  return { observed: media.length, bound: media.filter(image => image.id && snapshot.saved?.media.includes(image.id)).length, pending: media.filter(image => !image.id || !image.localId || image.localIdIsFallback || !image.category).length };
}

function allReady(snapshot: DraftSnapshot, media: ObservedMedia[]): boolean {
  return snapshot.saved !== null && media.every(image => image.id !== null && image.localId && !image.localIdIsFallback && image.category && snapshot.saved?.media.includes(image.id));
}

function remember(matched: Map<Identity, ObservedMedia>, snapshot: DraftSnapshot): Map<ObservedMedia, ObservedMedia> {
  // Unique identity evidence is usable before saved metadata catches up. Binding
  // is still mandatory for confirmation and before the next native upload.
  const known = new Map<ObservedMedia, ObservedMedia>();
  for (const [owner, image] of matched) {
    observe(owner, image, snapshot.documentId);
    known.set(image, knownMetadata(image, owner.current));
  }
  return known;
}

function readySignature(media: ObservedMedia[]): string {
  // Entity keys can be rebuilt while the native media identity remains stable.
  return JSON.stringify(media.map(image => [image.id, image.localIdIsFallback ? null : image.localId, image.category]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

function results(session: MediaUploadSession, assets: MediaAsset[]): MediaResult[] {
  return assets.map(asset => {
    const found = session.confirmed?.filter(image => image.source === asset.source);
    if (found?.length !== 1 || !found[0]) throw new Error('已确认图片来源不完整，操作已停止。');
    if (!found[0].current.localId || found[0].current.localIdIsFallback || !found[0].current.category) throw new Error('MXP_MEDIA_STATE_UNSTABLE: 图片的真实本地标识或媒体类别尚未就绪，不能保存正文。');
    return { source: asset.source, ...found[0].current };
  });
}

async function read(bridge: BrowserBridge, articleId: string, session: MediaUploadSession, uploadId?: string, deadline = Date.now() + TIMEOUT, onUnavailable?: () => void): Promise<{ snapshot: DraftSnapshot; media: ObservedMedia[] }> {
  while (Date.now() < deadline) {
    const snapshot = await runPage<DraftSnapshot>(bridge, { kind: 'read', id: articleId, uploadId });
    assertPage(snapshot, articleId);
    if (snapshot.content !== null && snapshot.content !== undefined) {
      const { body, media } = inspect(snapshot.content);
      checkBody(session, body);
      return { snapshot, media };
    }
    onUnavailable?.();
    await new Promise<void>(resolve => setTimeout(resolve, INTERVAL));
  }
  throw new Error('MXP_MEDIA_STATE_UNSTABLE: 编辑器状态长时间未恢复，已停止图片上传并保留进度。');
}

/** Wait without ever resubmitting an uncertain upload, including after reload. */
async function settle(bridge: BrowserBridge, articleId: string, session: MediaUploadSession, total: number, progress: Progress, diagnostic: DiagnosticSink): Promise<void> {
  const pending = session.pending;
  if (!pending) return;
  const started = Date.now();
  let reportAt = started + REPORT_INTERVAL;
  let stable: { signature: string; since: number } | undefined;
  let metadataPending = false;
  const completed = session.confirmed?.filter(image => image.source !== undefined).length ?? 0;
  while (Date.now() - started < TIMEOUT) {
    const { snapshot, media } = await read(bridge, articleId, session, pending.uploadId, started + TIMEOUT, () => {
      if (Date.now() < reportAt) return;
      progress(`图片上传仍在等待：已确认 ${completed}/${total}，编辑器正在恢复。`);
      diagnostic('media_upload_waiting', { completed, total, state: 'editor_unavailable', elapsedSeconds: Math.floor((Date.now() - started) / 1000) });
      reportAt = Date.now() + REPORT_INTERVAL;
    });
    const { matched, extra } = reconcile(pending.before, media, snapshot.documentId);
    if (extra.length > 1) throw new Error('MXP_MEDIA_IDENTITY_AMBIGUOUS: 上传期间出现额外图片，已停止后续上传。');
    const known = remember(matched, snapshot);
    const next = extra[0];
    if (next) {
      if (pending.candidate) {
        const matchedCandidate = reconcile([...pending.before, pending.candidate], media, snapshot.documentId).matched;
        for (const [observed, resolved] of remember(matchedCandidate, snapshot)) known.set(observed, resolved);
      } else if (next.id) {
        pending.candidate = identity(next, snapshot.documentId, pending.source);
      }
    }
    const resolved = media.map(image => known.get(image) ?? image);
    metadataPending = resolved.some(image => image.id && (!image.localId || image.localIdIsFallback || !image.category));
    if (next && pending.candidate && allReady(snapshot, resolved)) {
      const signature = readySignature(resolved);
      if (stable?.signature === signature) {
        if (Date.now() - stable.since >= INTERVAL) {
          session.confirmed = [...pending.before, pending.candidate];
          delete session.pending;
          diagnostic('media_upload_confirmed', { completed: completed + 1, total, ...counts(snapshot, resolved) });
          return;
        }
      } else {
        stable = { signature, since: Date.now() };
      }
    } else stable = undefined;
    // A failed DOM handoff does not prove the upload failed to finish.
    // Return control once; an explicit continuation observes even rejected tokens.
    if (snapshot.upload?.state === 'rejected' && !pending.interrupted) throw new Error('图片提交操作报告失败；上传可能仍在完成，请稍后继续核对。');
    if (Date.now() >= reportAt) {
      const count = counts(snapshot, resolved);
      progress(`图片上传仍在等待：已确认 ${completed}/${total}，当前图片 ${count.observed}，已绑定 ${count.bound}。`);
      diagnostic('media_upload_waiting', { completed, total, ...count, state: metadataPending ? 'metadata_pending' : snapshot.upload?.state ?? 'unknown', elapsedSeconds: Math.floor((Date.now() - started) / 1000) });
      reportAt = Date.now() + REPORT_INTERVAL;
    }
    await new Promise<void>(resolve => setTimeout(resolve, INTERVAL));
  }
  if (metadataPending) throw new Error('MXP_MEDIA_STATE_UNSTABLE: 图片的真实本地标识或媒体类别在 180 秒内仍未就绪，已保留进度；稍后继续不会重复上传。');
  throw new Error('MXP_MEDIA_UPLOAD_TIMEOUT: 图片上传等待超过 180 秒，已保留进度；稍后继续只会核对这张图片，不会重复上传。');
}

export async function uploadArticleMedia(bridge: BrowserBridge, articleId: string, assets: MediaAsset[], progress: Progress, diagnostic: DiagnosticSink, session: MediaUploadSession): Promise<MediaResult[]> {
  if (session.active) throw new ResumeRejectedError('图片上传正在进行，请等待当前操作结束。');
  if (new Set(assets.map(asset => asset.source)).size !== assets.length) throw new ResumeRejectedError('上传资产来源重复，操作已停止。');
  const fingerprint = createHash('sha256').update(JSON.stringify(assets.map(asset => [asset.source, asset.name, asset.mime, asset.base64]))).digest('hex');
  if (session.articleId !== undefined && (session.articleId !== articleId || session.assetsFingerprint !== fingerprint)) throw new ResumeRejectedError('草稿或图片资产已变化，不能继续此前的上传。');
  session.active = true;
  try {
    if (session.articleId === undefined) {
      const { snapshot, media } = await read(bridge, articleId, session);
      if (media.length) throw new ResumeRejectedError('开始上传前草稿已出现图片，不能将本次上传合并到已改变的内容。');
      if (!allReady(snapshot, media)) throw new Error('MXP_MEDIA_STATE_UNSTABLE: 草稿保存状态尚未就绪，未开始上传。');
      const initial = media.map(image => identity(image, snapshot.documentId));
      reconcile(initial, media, snapshot.documentId);
      session.articleId = articleId;
      session.assetsFingerprint = fingerprint;
      session.body = inspect(snapshot.content).body;
      session.confirmed = initial;
    }
    if (session.pending) {
      session.pending.interrupted = true;
      progress('正在核对上次尚未确认的图片，不会重复上传。');
      await settle(bridge, articleId, session, assets.length, progress, diagnostic);
    }
    for (const asset of assets) {
      if (session.confirmed?.some(image => image.source === asset.source)) continue;
      const { snapshot, media } = await read(bridge, articleId, session);
      const confirmed = session.confirmed ?? [];
      const { matched, extra } = reconcile(confirmed, media, snapshot.documentId);
      if (extra.length) throw new Error('MXP_MEDIA_IDENTITY_AMBIGUOUS: 开始上传前出现额外图片，操作已停止。');
      const known = remember(matched, snapshot);
      if (!allReady(snapshot, media.map(image => known.get(image) ?? image))) throw new Error('MXP_MEDIA_STATE_UNSTABLE: 旧图片尚未就绪或绑定，未开始下一张上传。');
      const pending: PendingUpload = { uploadId: randomUUID(), source: asset.source, before: cloneIdentities(confirmed), interrupted: false };
      // Persist BEFORE the bridge call: a lost reply is an uncertain submission.
      session.pending = pending;
      const completed = confirmed.filter(image => image.source !== undefined).length;
      progress(`正在上传图片 ${completed + 1}/${assets.length}。`);
      diagnostic('media_upload_started', { completed, total: assets.length });
      const response = await runPage<{ state: 'submitted' | 'rejected' | 'missing' } | { state: 'not-submitted'; reason: string }>(bridge, { kind: 'upload', id: articleId, uploadId: pending.uploadId, asset: { name: asset.name, mime: asset.mime, base64: asset.base64 } });
      if (response.state === 'not-submitted') {
        // Only this explicit page-side proof permits retrying the file. A thrown
        // bridge call or an unknown reply still leaves submission uncertain.
        delete session.pending;
        const reason = typeof response.reason === 'string' && response.reason.trim() ? response.reason.trim() : 'X 图片入口尚未准备好。';
        throw new Error(`图片尚未提交：${reason} 处理页面提示后可再次继续上传。`);
      }
      if (response.state !== 'submitted') throw new Error('本次原生上传未得到确认，已保留进度；请稍后继续核对。');
      await settle(bridge, articleId, session, assets.length, progress, diagnostic);
    }
    const { snapshot, media } = await read(bridge, articleId, session);
    const { matched, extra } = reconcile(session.confirmed ?? [], media, snapshot.documentId);
    const known = remember(matched, snapshot);
    if (extra.length || !allReady(snapshot, media.map(image => known.get(image) ?? image))) throw new Error('MXP_MEDIA_STATE_UNSTABLE: 上传结束时图片数量或保存绑定不一致，操作已停止。');
    session.result = results(session, assets);
    return session.result;
  } catch (error) {
    if (session.pending) session.pending.interrupted = true;
    diagnostic('media_upload_stopped', { completed: session.confirmed?.filter(image => image.source !== undefined).length ?? 0, total: assets.length, pending: session.pending !== undefined, state: error instanceof PageChangedError ? 'page_changed' : error instanceof ResumeRejectedError ? 'resume_rejected' : 'unconfirmed' });
    throw error;
  } finally {
    session.active = false;
  }
}
