import type { XContent } from '../model';

type RecordValue = Record<string, unknown>;
interface ComparableBlock { type: string; text: string; styles: string[]; entities: string[]; }

function object(value: unknown, context: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context}格式无效。`);
  return value as RecordValue;
}

function list(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context}列表缺失。`);
  return value as unknown[];
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context}必须是文字。`);
  return value;
}

/** Reject both transport failures and GraphQL failures hidden behind HTTP 200. */
export function verifyMutation(response: unknown, operation: string): void {
  const result = object(response, operation);
  if (typeof result.status !== 'number' || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300) {
    throw new Error(`${operation}失败：HTTP ${String(result.status)}。`);
  }
  const body = object(result.body, `${operation}响应`);
  if (body.errors !== undefined && body.errors !== null && (!Array.isArray(body.errors) || body.errors.length > 0)) {
    const first = Array.isArray(body.errors) ? body.errors[0] as unknown : body.errors;
    const message = first && typeof first === 'object' && 'message' in first ? String(first.message).slice(0, 300) : '未知 GraphQL 错误';
    throw new Error(`${operation}失败：${message}`);
  }
  const data = object(body.data, `${operation}结果`);
  if (!Object.values(data).some(value => value !== null && value !== undefined)) throw new Error(`${operation}未返回有效保存结果。`);
}

function bounds(value: RecordValue, text: string): [number, number] {
  const start = value.offset, length = value.length;
  if (typeof start !== 'number' || typeof length !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || start + length > text.length) {
    throw new Error('正文的文字范围无效。');
  }
  return [start, start + length];
}

function mediaId(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) throw new Error('图片 ID 缺失。');
  return String(value);
}

export function contentMediaIds(content: unknown): string[] {
  const value = object(content, '正文');
  const result: string[] = [];
  for (const entry of list(value.entity_map, '实体')) {
    const entity = object(object(entry, '实体项').value, '实体');
    if (entity.type !== 'MEDIA') continue;
    const data = object(entity.data, '图片');
    for (const item of list(data.media_items ?? data.mediaItems, '图片')) {
      const media = object(item, '图片');
      result.push(mediaId(media.media_id ?? media.mediaId));
    }
  }
  return result;
}

function comparable(content: unknown): ComparableBlock[] {
  const value = object(content, '正文');
  const entities = new Map<string, RecordValue>();
  for (const item of list(value.entity_map, '实体')) {
    const entry = object(item, '实体项');
    const key = String(entry.key);
    if (entities.has(key)) throw new Error('实体键重复。');
    entities.set(key, object(entry.value, '实体内容'));
  }
  const blocks = list(value.blocks, '段落').map(item => {
    const block = object(item, '段落');
    const text = string(block.text, '正文文字');
    const type = string(block.type, '段落类型');
    // Compare style coverage per UTF-16 code unit, allowing Draft to split ranges.
    const coverage = Array.from({ length: text.length }, () => new Set<string>());
    for (const item of list(block.inline_style_ranges, '样式')) {
      const range = object(item, '样式范围');
      const [start, end] = bounds(range, text);
      const style = string(range.style, '样式名称').toUpperCase();
      for (let position = start; position < end; position++) coverage[position]?.add(style);
    }
    const signatures: string[] = [];
    for (const item of list(block.entity_ranges, '实体范围')) {
      const range = object(item, '实体范围');
      const [start, end] = bounds(range, text);
      const entity = entities.get(String(range.key));
      if (!entity) throw new Error('正文引用了不存在的实体。');
      const kind = string(entity.type, '实体类型').toUpperCase();
      if (kind === 'TWEMOJI' && type !== 'atomic') continue;
      const data = object(entity.data, '实体数据');
      let payload: unknown;
      switch (kind) {
        case 'LINK': payload = string(data.url, '链接'); break;
        case 'MARKDOWN': payload = string(data.markdown, '代码或表格'); break;
        case 'MEDIA': {
          const items = list(data.media_items ?? data.mediaItems, '图片');
          if (!items.length) throw new Error('图片实体为空。');
          payload = items.map(item => { const media = object(item, '图片'); return mediaId(media.media_id ?? media.mediaId); });
          break;
        }
        default: throw new Error(`无法核验实体类型 ${kind}。`);
      }
      signatures.push(JSON.stringify([start, end, kind, payload]));
    }
    if (type === 'atomic' && signatures.length === 0) throw new Error('原子段落缺少图片、代码或表格。');
    return { type, text, styles: coverage.map(styles => [...styles].sort().join(',')), entities: signatures.sort() };
  });
  // Draft appends an empty caret paragraph after atomic blocks.
  while (blocks.length > 1) {
    const end = blocks.at(-1);
    if (!end || end.type !== 'unstyled' || end.text || end.entities.length || end.styles.length) break;
    blocks.pop();
  }
  if (!blocks.length) throw new Error('没有可核验的正文段落。');
  return blocks;
}

/** Editor keys and emoji decorations may change; content and formatting may not. */
export function verifyContent(expected: XContent, actual: unknown): void {
  const left = comparable(expected), right = comparable(actual);
  if (left.length !== right.length) throw new Error(`正文段落数量不一致：${left.length} / ${right.length}。`);
  for (let index = 0; index < left.length; index++) {
    const before = left[index], after = right[index];
    if (!before || !after) throw new Error('正文段落缺失。');
    const label = `第 ${index + 1} 段`;
    if (before.type !== after.type) throw new Error(`${label}类型不一致。`);
    if (before.text !== after.text) throw new Error(`${label}完整文字不一致。`);
    if (JSON.stringify(before.styles) !== JSON.stringify(after.styles)) throw new Error(`${label}文字样式不一致。`);
    if (JSON.stringify(before.entities) !== JSON.stringify(after.entities)) throw new Error(`${label}链接、图片、代码或表格不一致。`);
  }
}

export interface DraftSnapshot {
  url: string;
  id: string | null;
  documentId?: string;
  upload?: { state: 'submitted' | 'rejected' | 'missing' };
  content: unknown | null;
  titleInputs: string[];
  saved: { title: string; cover: string | null; media: string[] } | null;
}

export function verifyDraft(snapshot: DraftSnapshot, id: string, title: string, content: XContent, cover: string | null): void {
  if (snapshot.id !== id) throw new Error('浏览器已离开本次草稿。');
  if (!snapshot.saved || snapshot.saved.title !== title || !snapshot.titleInputs.includes(title)) throw new Error('刷新后的完整标题不一致。');
  if (snapshot.saved.cover !== cover) throw new Error('刷新后的封面不一致。');
  verifyContent(content, snapshot.content);
  if (contentMediaIds(content).some(id => !snapshot.saved?.media.includes(id))) throw new Error('正文图片没有完整绑定到草稿。');
}
