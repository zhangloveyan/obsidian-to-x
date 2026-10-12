import { serializeContent } from '../content/article';
import type { BrowserBridge, MediaAsset, UploadedMedia, XContent } from '../model';
import type { DraftSnapshot } from './x-protocol';

interface Character { getEntity(): string | null; getStyle(): { toArray(): string[]; has(value: string): boolean }; }
interface DraftBlock {
  getKey(): string;
  getType(): string;
  getText(): string;
  getCharacterList(): { get(index: number): Character; toArray(): Character[] };
  findEntityRanges(filter: (character: Character) => boolean, callback: (start: number, end: number) => void): void;
  findStyleRanges(filter: (character: Character) => boolean, callback: (start: number, end: number) => void): void;
}
interface DraftContent {
  getBlockMap(): { toArray(): DraftBlock[] };
  getEntity(key: string): { getType(): string; getData(): Record<string, unknown>; getMutability(): string };
}
interface EditorProps {
  editorState?: { getCurrentContent(): DraftContent };
  onFilesAdded?: (files: File[]) => unknown;
}
interface Fiber {
  return?: Fiber;
  memoizedProps?: EditorProps & { value?: { store?: { getState(): { entities?: { articleEntities?: { entities?: Record<string, SavedArticle> } } } } } };
  stateNode?: { props?: EditorProps };
}
interface SavedArticle { title?: string; cover_media?: { media_id?: string }; media_entities?: Array<{ media_id: string }>; }
interface ObservedMedia extends UploadedMedia { localIdIsFallback: boolean; }
export type PageAction =
  | { kind: 'read'; id?: string; uploadId?: string }
  | { kind: 'upload'; id: string; uploadId: string; asset: Pick<MediaAsset, 'name' | 'mime' | 'base64'> }
  | { kind: 'focus'; id: string }
  | { kind: 'create' }
  | { kind: 'toast'; id: string };

interface PageMemory {
  documentId: string;
  uploads: Record<string, { articleId: string; state: 'submitted' | 'rejected' }>;
}

export class PageChangedError extends Error {
  constructor(message = '浏览器已离开本次草稿，操作已停止。') { super(message); this.name = 'PageChangedError'; }
}

export class PageOperationError extends Error {
  constructor(message: string) { super(message); this.name = 'PageOperationError'; }
}

/** Retained progress no longer belongs to the current article content. */
export class ResumeRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'ResumeRejectedError'; }
}

/** A reload can hydrate saved metadata before the editor's image blocks. */
export class DraftMediaPendingError extends Error {
  constructor(message: string) { super(message); this.name = 'DraftMediaPendingError'; }
}

/** This function is serialized into the authenticated page. It has no host closures. */
async function pageProgram(action: PageAction): Promise<unknown> {
  if (location.hostname !== 'x.com') throw new Error('MXP_PAGE_CHANGED: 当前页面不是 X，操作已停止。');
  if (/\/(?:i\/flow\/)?login(?:\/|$)/.test(location.pathname)) throw new Error('MXP_PAGE_CHANGED: 请先在 Chrome 中登录 X。');
  const pathId = location.pathname.match(/\/articles\/edit\/(\d+)\/?$/)?.[1] ?? null;
  if ('id' in action && action.id !== undefined && action.id !== pathId) throw new Error('MXP_PAGE_CHANGED: 浏览器已离开本次草稿，操作已停止。');
  if (action.kind === 'toast') {
    const old = document.getElementById('markdown-x-publisher-status');
    old?.remove();
    const note = document.createElement('aside');
    note.id = 'markdown-x-publisher-status';
    note.setAttribute('role', 'status');
    note.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:320px;padding:14px 42px 14px 16px;border-radius:12px;background:Canvas;color:CanvasText;border:1px solid #8886;box-shadow:0 4px 18px #0002;font:14px/1.5 system-ui;';
    note.textContent = '草稿已保存并核对，请检查后手动发布。';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '×';
    button.setAttribute('aria-label', '关闭草稿保存提示');
    button.style.cssText = 'position:absolute;top:9px;right:9px;border:0;background:none;color:inherit;font-size:22px;cursor:pointer;';
    button.onclick = () => note.remove();
    note.append(button);
    document.body.append(note);
    setTimeout(() => note.remove(), 3000);
    return true;
  }
  if (action.kind === 'create') {
    if (location.pathname !== '/compose/articles') throw new Error('MXP_PAGE_CHANGED: 页面已离开 X 文章列表，未创建草稿。');
    const previous = [...document.querySelectorAll('a[href]')].flatMap(link => {
      const match = link.getAttribute('href')?.match(/\/articles\/edit\/(\d+)/);
      return match?.[1] ? [match[1]] : [];
    });
    const root = document.querySelector('main') ?? document.body;
    const names = new Set(['create', 'compose', 'write', 'new article', 'create article', 'write an article', '撰写', '创建', '新建', '新建文章', '创建文章', '作成', '作成する', '記事を作成', 'créer', 'écrire', 'redactar', 'escribir', 'schreiben', 'verfassen', 'escrever', '새 글 작성', '글 작성']);
    const controls = [...root.querySelectorAll<HTMLElement>('button,a[role="button"],a[data-testid="empty_state_button_text"]')].filter(control => {
      const rect = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' || control.getAttribute('aria-disabled') === 'true' || control.hasAttribute('disabled')) return false;
      if ((control.getAttribute('href') ?? '').includes('/articles/edit/')) return false;
      const label = (control.getAttribute('aria-label') || control.textContent || '').trim().toLowerCase();
      if (names.has(label)) return true;
      if (control.tagName !== 'BUTTON') return control.getAttribute('data-testid') === 'empty_state_button_text';
      // Observed X compose icon; it is never used to select a draft link.
      return control.tagName === 'BUTTON' && [...control.querySelectorAll('svg path')].some(path => (path.getAttribute('d') ?? '').startsWith('M14.543 5.04297'));
    });
    // X can show the heading's create button together with a sidebar's empty
    // state link. The native button is the primary action; links are fallback.
    const buttons = controls.filter(control => control.tagName === 'BUTTON');
    const candidates = buttons.length ? buttons : controls;
    if (candidates.length > 1) throw new Error(`MXP_CREATE_AMBIGUOUS: 找到 ${candidates.length} 个新建文章入口，无法确定安全的创建按钮。`);
    if (!candidates.length) throw new Error('未找到新建文章入口，请等待 X 文章列表加载完成。');
    candidates[0]?.click();
    return { previous };
  }
  const editor = document.querySelector<HTMLElement>('[data-contents="true"]')?.closest<HTMLElement>('[contenteditable="true"]') ?? null;
  let fiber: Fiber | undefined;
  if (editor) {
    const key = Object.keys(editor).find(key => key.startsWith('__reactFiber$'));
    fiber = key ? (editor as unknown as Record<string, Fiber>)[key] : undefined;
  }
  let content: DraftContent | undefined;
  let saved: SavedArticle | undefined;
  let uploadOwner: EditorProps | undefined;
  for (let current = fiber, depth = 0; current && depth < 180; current = current.return, depth++) {
    const props = current.stateNode?.props;
    content ??= props?.editorState?.getCurrentContent();
    if (!uploadOwner) uploadOwner = typeof props?.onFilesAdded === 'function' ? props
      : typeof current.memoizedProps?.onFilesAdded === 'function' ? current.memoizedProps : undefined;
    if (pathId && !saved) saved = current.memoizedProps?.value?.store?.getState().entities?.articleEntities?.entities?.[pathId];
  }
  if (action.kind === 'focus') {
    if (!editor || !content) throw new Error('X 文章编辑器尚未准备好。');
    editor.focus();
    return true;
  }
  const scope = globalThis as typeof globalThis & { __markdownXPublisherMedia?: PageMemory };
  const memory = scope.__markdownXPublisherMedia ??= { documentId: crypto.randomUUID(), uploads: Object.create(null) as PageMemory['uploads'] };
  if (action.kind === 'upload') {
    const previous = memory.uploads[action.uploadId];
    if (previous) {
      if (previous.articleId !== action.id) throw new Error('MXP_RESUME_MISMATCH: 上传标识属于另一篇草稿。');
      return { state: previous.state };
    }
    if (!editor || !content || !uploadOwner?.onFilesAdded) throw new Error('当前 X 编辑器尚未提供原生图片上传接口。');
    if (!action.uploadId || !action.asset.name || !action.asset.mime.startsWith('image/') || !action.asset.base64) throw new Error('图片上传参数无效。');
    const decoded = atob(action.asset.base64);
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    const file = new File([bytes], action.asset.name, { type: action.asset.mime });
    // Record submission before invoking X: a thrown/rejected callback may still
    // have scheduled an upload. The host observes it instead of retrying bytes.
    const entry: PageMemory['uploads'][string] = { articleId: action.id, state: 'submitted' };
    memory.uploads[action.uploadId] = entry;
    try {
      void Promise.resolve(uploadOwner.onFilesAdded([file])).catch(() => { entry.state = 'rejected'; });
    } catch { entry.state = 'rejected'; }
    return { state: entry.state };
  }
  const entity_map: Array<{ key: string; value: { type: string; mutability: string; data: Record<string, unknown> } }> = [];
  const seen = new Set<string>();
  const blocks = content?.getBlockMap().toArray().map(block => {
    const entity_ranges: Array<{ key: string; offset: number; length: number }> = [];
    const inline_style_ranges: Array<{ style: string; offset: number; length: number }> = [];
    block.findEntityRanges(character => character.getEntity() !== null, (start, end) => {
      const key = block.getCharacterList().get(start).getEntity();
      if (key === null || !content) return;
      entity_ranges.push({ key, offset: start, length: end - start });
      if (!seen.has(key)) {
        const entity = content.getEntity(key);
        entity_map.push({ key, value: { type: entity.getType(), mutability: entity.getMutability(), data: entity.getData() } });
        seen.add(key);
      }
    });
    const styles = new Set(block.getCharacterList().toArray().flatMap(character => character.getStyle().toArray()));
    for (const style of styles) block.findStyleRanges(character => character.getStyle().has(style), (start, end) => inline_style_ranges.push({ style, offset: start, length: end - start }));
    return { key: block.getKey(), type: block.getType(), text: block.getText(), data: {}, entity_ranges, inline_style_ranges };
  });
  return {
    url: location.href, id: pathId, documentId: memory.documentId,
    ...(action.uploadId ? { upload: { state: memory.uploads[action.uploadId]?.articleId === pathId ? memory.uploads[action.uploadId]!.state : 'missing' as const } } : {}),
    content: blocks ? { blocks, entity_map } : null,
    titleInputs: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].map(input => input.value),
    saved: saved ? { title: saved.title ?? '', cover: saved.cover_media?.media_id ? String(saved.cover_media.media_id) : null, media: (saved.media_entities ?? []).map(media => String(media.media_id)) } : null,
  } satisfies DraftSnapshot;
}

export async function runPage<T>(bridge: BrowserBridge, action: PageAction): Promise<T> {
  try {
    return await bridge.evaluate<T>(`(${pageProgram.toString()})(${JSON.stringify(action)})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const marker = 'MXP_PAGE_CHANGED:';
    const offset = message.indexOf(marker);
    if (offset >= 0) throw new PageChangedError(message.slice(offset + marker.length).trim());
    const resume = message.indexOf('MXP_RESUME_MISMATCH:');
    if (resume >= 0) throw new ResumeRejectedError(message.slice(resume + 'MXP_RESUME_MISMATCH:'.length).trim());
    const ambiguous = message.indexOf('MXP_CREATE_AMBIGUOUS:');
    if (ambiguous >= 0) throw new PageOperationError(message.slice(ambiguous + 'MXP_CREATE_AMBIGUOUS:'.length).split('\n')[0]!.trim());
    if (/\b(?:ReferenceError|SyntaxError|TypeError):/.test(message)) throw new PageOperationError(message);
    throw error;
  }
}

export async function waitFor<T>(label: string, probe: () => Promise<T | null>, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last = '页面尚未准备好';
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== null) return result;
    } catch (error) {
      if (error instanceof PageChangedError || error instanceof PageOperationError || error instanceof ResumeRejectedError) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  throw new Error(`${label}超时：${last}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效。`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value)) throw new Error(`${label}缺失。`);
  return String(value);
}

function observedMedia(entityKey: string, item: Record<string, unknown>): ObservedMedia {
  const localId = item.localMediaId ?? item.local_media_id;
  return {
    id: identifier(item.mediaId ?? item.media_id, '图片上传 ID'),
    localId: identifier(localId ?? '1', '图片本地标识'),
    localIdIsFallback: localId === undefined || localId === null,
    category: identifier(item.mediaCategory ?? item.media_category ?? 'DraftTweetImage', '图片媒体类别'),
    entityKey,
  };
}

/** Only our freshly uploaded images and empty caret paragraphs may be checkpointed. */
function imageDraft(content: unknown): ObservedMedia[] {
  const draft = record(content, '图片草稿');
  if (!Array.isArray(draft.blocks) || !Array.isArray(draft.entity_map)) throw new Error('图片草稿缺少段落或实体。');
  const entities = new Map<string, Record<string, unknown>>();
  for (const value of draft.entity_map) {
    const entry = record(value, '图片实体');
    const key = identifier(entry.key, '图片实体键');
    if (entities.has(key)) throw new Error('图片实体键重复。');
    entities.set(key, record(entry.value, '图片实体内容'));
  }
  const result: ObservedMedia[] = [];
  const referenced = new Set<string>();
  for (const value of draft.blocks) {
    const block = record(value, '图片段落');
    if (!Array.isArray(block.entity_ranges) || !Array.isArray(block.inline_style_ranges)) throw new Error('图片段落范围缺失。');
    if (block.type === 'unstyled' && block.text === '' && !block.entity_ranges.length && !block.inline_style_ranges.length) continue;
    if (block.type !== 'atomic' || block.text !== ' ' || block.entity_ranges.length !== 1 || block.inline_style_ranges.length) throw new Error('图片检查点中出现非图片正文，已停止以保护编辑内容。');
    const range = record(block.entity_ranges[0], '图片引用');
    if (range.offset !== 0 || range.length !== 1) throw new Error('图片引用范围无效。');
    const key = identifier(range.key, '图片引用键');
    const entity = entities.get(key);
    if (!entity || entity.type !== 'MEDIA' || referenced.has(key)) throw new Error('图片检查点包含缺失、重复或非图片实体。');
    referenced.add(key);
    const data = record(entity.data, '图片数据');
    const items = data.mediaItems ?? data.media_items;
    if (!Array.isArray(items) || items.length !== 1) throw new Error('每个上传图片实体必须对应一张图片。');
    const item = record(items[0], '图片媒体数据');
    result.push(observedMedia(key, item));
  }
  if (referenced.size !== entities.size) throw new Error('图片草稿包含未引用的实体。');
  return result;
}

function matchImages(previous: Map<string, UploadedMedia>, current: ObservedMedia[], sameDocument: boolean): { media: Map<string, UploadedMedia>; order: string[] } {
  if (previous.size !== current.length) {
    const message = `图片数量不一致：预期 ${previous.size} 张，编辑器 ${current.length} 张。`;
    if (current.length < previous.size) throw new DraftMediaPendingError(message);
    throw new Error(message);
  }
  const entries = [...previous.entries()];
  const media = new Map<string, UploadedMedia>();
  const order: string[] = [];
  for (const image of current) {
    const matches = (field: 'id' | 'localId' | 'entityKey') => {
      const value = image[field];
      const trusted = (media: UploadedMedia) => field !== 'localId' || (media as Partial<ObservedMedia>).localIdIsFallback !== true;
      if (!value || !trusted(image) || current.filter(other => trusted(other) && other[field] === value).length !== 1) return [];
      const found = entries.filter(([, earlier]) => trusted(earlier) && earlier[field] === value);
      return found.length === 1 ? found : [];
    };
    // Draft entity keys identify an upload only within the current document.
    // Reload regenerates them, so matching by their order or value is unsafe.
    const entity = sameDocument ? matches('entityKey')[0] : undefined;
    const local = matches('localId')[0];
    const stableId = matches('id')[0];
    if (new Set([entity, local, stableId].flatMap(match => match ? [match[0]] : [])).size > 1) throw new Error('图片实体、本地标识与媒体 ID 指向不同来源，已停止保存。');
    const source = (entity ?? local ?? stableId)?.[0];
    if (!source || media.has(source)) throw new Error('刷新前后无法唯一对应图片来源（本地标识及媒体 ID 已变化或重复），已停止保存。');
    if (previous.get(source)?.category !== image.category) throw new Error('刷新前后图片媒体类别不一致。');
    media.set(source, image);
    order.push(source);
  }
  return { media, order };
}

export interface ImageCheckpoint { content: XContent; media: Map<string, UploadedMedia>; order: string[]; }

export function createImageCheckpoint(content: unknown, uploaded: Map<string, UploadedMedia>): ImageCheckpoint {
  const matched = matchImages(uploaded, imageDraft(content), true);
  const blocks = matched.order.map(source => ({ type: 'image' as const, source, alt: '' }));
  return { ...matched, content: serializeContent(blocks, matched.media) };
}

export function verifyImageCheckpoint(snapshot: DraftSnapshot, checkpoint: ImageCheckpoint): Map<string, UploadedMedia> {
  const matched = matchImages(checkpoint.media, imageDraft(snapshot.content), false);
  if (matched.order.some((source, index) => source !== checkpoint.order[index])) throw new Error('刷新后的图片顺序与上传检查点不一致。');
  const bound = [...matched.media.values()].filter(image => snapshot.saved?.media.includes(image.id)).length;
  if (bound !== checkpoint.media.size) throw new Error(`图片未完整保存：预期 ${checkpoint.media.size} 张，页面 ${matched.media.size} 张，已保存 ${bound} 张。`);
  return matched.media;
}

/** Reconcile uploaded media after reload using verified identities. */
export function verifyInjectedMedia(snapshot: DraftSnapshot, uploaded: Array<UploadedMedia & { source: string }>): Map<string, UploadedMedia> {
  const content = record(snapshot.content, '已保存正文');
  if (!Array.isArray(content.blocks) || !Array.isArray(content.entity_map)) throw new Error('已保存正文缺少段落或实体。');
  const entities = content.entity_map.filter(value => record(record(value, '实体项').value, '实体').type === 'MEDIA');
  const keys = new Set(entities.map(value => identifier(record(value, '实体项').key, '图片实体键')));
  const blocks = content.blocks.filter(value => {
    const block = record(value, '段落');
    if (!Array.isArray(block.entity_ranges)) throw new Error('段落实体范围缺失。');
    return block.type === 'atomic' && block.entity_ranges.some(value => keys.has(identifier(record(value, '实体范围').key, '实体键')));
  });
  const previous = new Map(uploaded.map((image, index) => [String(index), image]));
  const matched = matchImages(previous, imageDraft({ blocks, entity_map: entities }), false);
  if ([...matched.media.values()].some(image => !snapshot.saved?.media.includes(image.id))) throw new DraftMediaPendingError('图片尚未完整绑定到已保存的文章，已停止后续写入。');
  const media = new Map<string, UploadedMedia>();
  for (const [key, image] of matched.media) media.set(uploaded[Number(key)]!.source, image);
  return media;
}

function toolText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return '';
  return result.content.flatMap((item: unknown) => item && typeof item === 'object' && 'text' in item && typeof item.text === 'string' ? [item.text] : []).join('\n');
}

export async function openArticleList(bridge: BrowserBridge): Promise<void> {
  const tabs = toolText(await bridge.call('browser_tabs', { action: 'list' }));
  const existing = tabs.split('\n').map(line => ({ line, match: line.match(/^\s*-\s*(\d+):.*\(https:\/\/(?:www\.)?(?:x|twitter)\.com(?:[/)])/i) })).find(tab => tab.match);
  if (existing?.match?.[1]) await bridge.call('browser_tabs', { action: 'select', index: Number(existing.match[1]) });
  else await bridge.call('browser_tabs', { action: 'new' });
  await bridge.call('browser_navigate', { url: 'https://x.com/compose/articles' });
}
