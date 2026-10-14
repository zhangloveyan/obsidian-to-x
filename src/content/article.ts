import MarkdownIt from 'markdown-it';
import type { ContentBlock, ParsedNote, TextKind, TextLink, TextStyle, UploadedMedia, XContent } from '../model';

const parser = new MarkdownIt({ html: true, linkify: false, typographer: false });
type Token = ReturnType<typeof parser.parse>[number];

// An inline rule keeps Obsidian embeds out of code spans, fences and escaped text.
parser.inline.ruler.before('image', 'obsidian-image', (state, silent) => {
  if (state.src.slice(state.pos, state.pos + 3) !== '![[') return false;
  const end = state.src.indexOf(']]', state.pos + 3);
  if (end < 0) return false;
  const reference = state.src.slice(state.pos + 3, end);
  if (reference.includes('\n')) return false;
  const source = reference.split('|')[0]?.trim();
  if (!source) return false;
  if (!silent) {
    const token = state.push('image', 'img', 0);
    token.attrs = [['src', source]];
    token.meta = { obsidianImage: true };
    token.content = source.split(/[\\/]/).pop() ?? source;
    token.children = [];
  }
  state.pos = end + 2;
  return true;
});

type TextBlock = Extract<ContentBlock, { type: 'text' }>;

function textBlock(kind: TextKind = 'unstyled'): TextBlock {
  return { type: 'text', kind, text: '', styles: [], links: [] };
}

function plainInline(tokens: Token[]): string {
  return tokens.map((token) => {
    if (token.type === 'image') return token.content;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    return token.nesting === 0 ? token.content : '';
  }).join('');
}

function imageSource(token: Token): string {
  const source = String(token.attrGet('src') ?? '');
  if (token.meta?.obsidianImage || /^https?:\/\//i.test(source)) return source;
  try { return decodeURIComponent(source); }
  catch { return source; }
}

// Obsidian properties are not article content or publishing options.
function stripProperties(markdown: string): string {
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') return lines.join('\n');
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  return (end < 0 ? lines : lines.slice(end + 1)).join('\n');
}

function escapedAt(source: string, position: number): boolean {
  let slashes = 0;
  while (position > 0 && source[--position] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Remove hidden author comments before both preview and serialization use the body. */
function stripComments(markdown: string): string {
  let source = markdown;
  // Reparse after each removal: a fence inside a removed comment must not turn
  // the following prose into a code block and shield another hidden comment.
  for (;;) {
    const lineStarts = [0];
    for (let index = 0; index < source.length; index++) if (source[index] === '\n') lineStarts.push(index + 1);
    const tokens = parser.parse(source, {});
    const regions = (types: string[]): Array<{ start: number; end: number }> => tokens
      .filter((token) => types.includes(token.type) && token.map)
      .map((token) => ({ start: lineStarts[token.map![0]] ?? source.length, end: lineStarts[token.map![1]] ?? source.length }));
    const codeRegions = regions(['fence', 'code_block']);
    const inlineRegions = regions(['inline']);
    // Table cell inline tokens have no line map. Locate each cell within its row
    // instead of allowing a code delimiter in one cell to match another cell.
    let rowCursor = -1;
    let rowEnd = -1;
    for (const token of tokens) {
      if (token.type === 'tr_open' && token.map) {
        rowCursor = lineStarts[token.map[0]] ?? source.length;
        rowEnd = lineStarts[token.map[1]] ?? source.length;
      } else if (token.type === 'tr_close') rowCursor = -1;
      else if (token.type === 'inline' && !token.map && rowCursor >= 0) {
        const start = source.indexOf(token.content, rowCursor);
        if (start >= rowCursor && start + token.content.length <= rowEnd) {
          inlineRegions.push({ start, end: start + token.content.length });
          rowCursor = start + token.content.length;
        } else if (token.children?.some((child) => child.type === 'code_inline' && /%%|<!--/.test(child.content))) {
          throw new Error('表格内代码与注释标记的边界无法确认。请将这段代码移出表格后重试。');
        }
      }
    }
    inlineRegions.sort((left, right) => left.start - right.start);
    let codeIndex = 0;
    let inlineIndex = 0;
    let removed = false;
    for (let cursor = 0; cursor < source.length;) {
      while (codeRegions[codeIndex] && codeRegions[codeIndex]!.end <= cursor) codeIndex++;
      while (inlineRegions[inlineIndex] && inlineRegions[inlineIndex]!.end <= cursor) inlineIndex++;
      const code = codeRegions[codeIndex];
      if (code && code.start <= cursor) { cursor = code.end; continue; }
      const inline = inlineRegions[inlineIndex];
      if (source[cursor] === '`' && !escapedAt(source, cursor) && inline && inline.start <= cursor) {
        let openerEnd = cursor + 1;
        while (source[openerEnd] === '`') openerEnd++;
        const size = openerEnd - cursor;
        let search = openerEnd;
        let matchedEnd = -1;
        while (search < inline.end) {
          const start = source.indexOf('`', search);
          if (start < 0 || start >= inline.end) break;
          let end = start + 1;
          while (source[end] === '`') end++;
          if (end - start === size) { matchedEnd = end; break; }
          search = end;
        }
        cursor = matchedEnd >= 0 ? matchedEnd : openerEnd;
        continue;
      }
      const obsidian = source.startsWith('%%', cursor);
      const html = source.startsWith('<!--', cursor);
      if ((!obsidian && !html) || escapedAt(source, cursor)) { cursor++; continue; }
      const openSize = obsidian ? 2 : 4;
      const closing = obsidian ? '%%' : '-->';
      let end = source.indexOf(closing, cursor + openSize);
      while (obsidian && end >= 0 && escapedAt(source, end)) end = source.indexOf(closing, end + closing.length);
      const line = source.slice(0, cursor).split('\n').length;
      if (end < 0) throw new Error(`第 ${line} 行的注释未闭合。请补全 ${closing} 后重试，避免发送隐藏内容。`);
      const lineStart = source.lastIndexOf('\n', cursor - 1) + 1;
      if (obsidian && source.slice(cursor, end).includes('\n') && source.slice(lineStart, cursor).trim()) {
        throw new Error(`第 ${line} 行的跨行 %% 注释需要从独立行开始。请调整注释后重试，避免发送隐藏内容。`);
      }
      end += closing.length;
      const newlines = source.slice(cursor, end).replace(/[^\n]/g, '');
      source = source.slice(0, cursor) + newlines + source.slice(end);
      removed = true;
      break;
    }
    if (!removed) return source;
  }
}

function addStyle(block: TextBlock, style: TextStyle['style'], offset: number, length: number): void {
  let previous: TextStyle | undefined;
  for (let index = block.styles.length - 1; index >= 0; index--) {
    if (block.styles[index]?.style === style) {
      previous = block.styles[index];
      break;
    }
  }
  if (previous && previous.offset + previous.length === offset) previous.length += length;
  else block.styles.push({ offset, length, style });
}

function addLink(block: TextBlock, url: string, offset: number, length: number): void {
  const previous = block.links.at(-1);
  if (previous?.url === url && previous.offset + previous.length === offset) previous.length += length;
  else block.links.push({ offset, length, url });
}

/** Unsupported inline syntax returns null so its original Markdown stays intact. */
function nativeInline(tokens: Token[], kind: TextKind): ContentBlock[] | null {
  const blocks: ContentBlock[] = [];
  const activeStyles: TextStyle['style'][] = [];
  const activeLinks: string[] = [];
  let current = textBlock(kind);
  let hasImage = false;
  const styleNames: Record<string, TextStyle['style']> = { strong: 'Bold', em: 'Italic', s: 'Strikethrough' };
  const append = (value: string): void => {
    if (!value) return;
    const offset = current.text.length;
    current.text += value;
    for (const style of new Set(activeStyles)) addStyle(current, style, offset, value.length);
    const url = activeLinks.at(-1);
    if (url) addLink(current, url, offset, value.length);
  };
  for (const token of tokens) {
    const name = token.type.replace(/_(open|close)$/, '');
    const style = styleNames[name];
    if (style && token.nesting) {
      if (token.nesting === 1) activeStyles.push(style);
      else {
        const position = activeStyles.lastIndexOf(style);
        if (position >= 0) activeStyles.splice(position, 1);
      }
      continue;
    }
    switch (token.type) {
      case 'text':
        append(token.content);
        break;
      case 'softbreak':
      case 'hardbreak':
        append('\n');
        break;
      case 'link_open': {
        const url = token.attrGet('href');
        if (!url || token.attrGet('title')) return null;
        activeLinks.push(String(url));
        break;
      }
      case 'link_close':
        activeLinks.pop();
        break;
      case 'image': {
        const source = imageSource(token);
        // Linked images and image titles need the complete Markdown expression.
        if (!source || activeLinks.length || token.attrGet('title')) return null;
        if (current.text || (!hasImage && (kind === 'ordered-list-item' || kind === 'unordered-list-item'))) blocks.push(current);
        blocks.push({ type: 'image', source: String(source), alt: token.content });
        hasImage = true;
        current = textBlock(kind === 'ordered-list-item' || kind === 'unordered-list-item' ? 'unstyled' : kind);
        break;
      }
      default:
        return null;
    }
  }
  if (current.text || !blocks.length) blocks.push(current);
  return blocks;
}

function matchingClose(tokens: Token[], start: number): number {
  let nesting = 0;
  for (let index = start; index < tokens.length; index++) {
    nesting += tokens[index]?.nesting ?? 0;
    if (nesting === 0) return index;
  }
  return start;
}

function nativeList(tokens: Token[], start: number, end: number): ContentBlock[] | null {
  const opener = tokens[start];
  const kind = opener?.type === 'ordered_list_open' ? 'ordered-list-item' : 'unordered-list-item';
  if (opener?.attrGet('start') && String(opener.attrGet('start')) !== '1') return null;
  const blocks: ContentBlock[] = [];
  let index = start + 1;
  while (index < end) {
    if (tokens[index]?.type !== 'list_item_open') return null;
    const itemEnd = matchingClose(tokens, index);
    if (tokens[index + 1]?.type !== 'paragraph_open' || tokens[index + 2]?.type !== 'inline'
      || tokens[index + 3]?.type !== 'paragraph_close' || itemEnd !== index + 4) return null;
    const item = nativeInline(tokens[index + 2]?.children ?? [], kind);
    if (!item) return null;
    blocks.push(...item);
    index = itemEnd + 1;
  }
  return blocks;
}

function nativeQuote(tokens: Token[], start: number, end: number): ContentBlock[] | null {
  const blocks: ContentBlock[] = [];
  for (let index = start + 1; index < end; index += 3) {
    if (tokens[index]?.type !== 'paragraph_open' || tokens[index + 1]?.type !== 'inline'
      || tokens[index + 2]?.type !== 'paragraph_close') return null;
    const paragraph = nativeInline(tokens[index + 1]?.children ?? [], 'blockquote');
    if (!paragraph) return null;
    blocks.push(...paragraph);
  }
  return blocks;
}

function containsImage(tokens: Token[]): boolean {
  return tokens.some((token) => token.type === 'image'
    || ((token.type === 'html_inline' || token.type === 'html_block') && /<(?:img|picture)\b/i.test(token.content))
    || (token.children && containsImage(token.children)));
}

export class ArticleImageError extends Error {
  constructor(
    readonly location: string,
    readonly reason: string,
    readonly context: Array<{ line: number; text: string; highlighted: boolean }>,
    readonly suggestion: string,
  ) {
    super(`${location}：${reason}\n\n原文附近：\n${context.map(row => `${row.highlighted ? '→' : ' '} ${row.line} | ${row.text}`).join('\n')}\n\n修改方法：${suggestion}`);
    this.name = 'ArticleImageError';
  }
}

function imageError(tokens: Token[], sourceLines: string[], lineNumbers: number[]): ArticleImageError {
  const root = tokens[0];
  let range = root?.map ?? [0, 1];
  // Inline tokens in table cells have no map; their row supplies the location.
  for (const token of tokens) {
    if (token.map) range = token.map;
    if ((token.type === 'inline' && containsImage(token.children ?? []))
      || (token.type === 'html_block' && containsImage([token]))) break;
  }
  const start = lineNumbers[range[0]] ?? 0;
  const end = lineNumbers[Math.max(range[0], range[1] - 1)] ?? start;
  const blockStart = lineNumbers[root?.map?.[0] ?? range[0]] ?? start;
  const blockEnd = lineNumbers[(root?.map?.[1] ?? range[1]) - 1] ?? end;
  const contextStart = Math.max(blockStart, start - 2);
  const contextEnd = Math.min(blockEnd, Math.max(end, start + 2));
  const context = sourceLines.slice(contextStart, contextEnd + 1).map((text, index) => ({
    line: contextStart + index + 1, text,
    highlighted: contextStart + index >= start && contextStart + index <= end,
  }));
  let structure = '图文混排段落';
  let suggestion = '将图片单独放在一个顶格的段落中，前后各留一个空行；图片不要包在链接里，也不要附加图片标题。';
  if (root?.type === 'ordered_list_open' || root?.type === 'bullet_list_open') {
    const ordered = root.type === 'ordered_list_open';
    structure = ordered ? '编号列表' : '无序列表';
    suggestion = ordered
      ? '将这组步骤改成普通段落，例如“第 1 步：…”。再删除图片行前的缩进，让图片顶格，前后各留一个空行。仅增加空行、保留缩进，图片仍然属于列表。'
      : '将这组列表文字改成普通段落，再删除图片行前的缩进，让图片顶格，前后各留一个空行。仅增加空行、保留缩进，图片仍然属于列表。';
  } else if (root?.type === 'table_open') {
    structure = '表格';
    suggestion = '将图片移到整个表格的前面或后面，单独占一段并顶格，前后各留一个空行。';
  } else if (root?.type === 'blockquote_open') {
    structure = '引用';
    suggestion = '将图片移到整段引用的外面，去掉图片行前的 > 和缩进，前后各留一个空行。';
  } else if (root?.type === 'heading_open') {
    structure = '标题';
    suggestion = '将图片移到标题下方，图片行前不要保留 # 或缩进，并在前后各留一个空行。';
  } else if (root?.type === 'html_block') {
    structure = 'HTML 段落';
    suggestion = '将 HTML 图片改为 ![说明](图片路径)，放在 HTML 外单独一段并顶格，前后各留一个空行。';
  }
  const location = `原文第 ${start + 1}${end > start ? `–${end + 1}` : ''} 行 · ${structure}`;
  return new ArticleImageError(location, `插件暂不支持这段${structure}中的图片。`, context, suggestion);
}

function preserveReferences(markdown: string, tokenGroup: Token[], environment: Parameters<typeof parser.parse>[1]): string {
  const hasLink = (tokens: Token[]): boolean => tokens.some((token) => token.type === 'link_open' || (token.children && hasLink(token.children)));
  if (!environment.references || !hasLink(tokenGroup)) return markdown;
  const definitions = Object.entries(environment.references).map(([label, reference]) => {
    const escapedLabel = label.replace(/([\\[\]])/g, '\\$1');
    const href = reference.href.replace(/>/g, '%3E');
    const title = reference.title ? ` "${reference.title.replace(/([\\"])/g, '\\$1')}"` : '';
    return `[${escapedLabel}]: <${href}>${title}`;
  });
  return definitions.length ? `${markdown}\n\n${definitions.join('\n')}` : markdown;
}

/** Parse authored Markdown without depending on Obsidian or a browser session. */
export function parseNote(markdown: string, filename: string): ParsedNote {
  const sourceLineCount = markdown.replace(/\r\n?/g, '\n').split('\n').length;
  let body = stripComments(stripProperties(markdown));
  const bodyLines = body.split('\n');
  const bodyLineCount = bodyLines.length;
  // Keep source line numbers without putting hidden comments back into the preview.
  const sourceLines = [...Array<string>(sourceLineCount - bodyLineCount).fill(''), ...bodyLines];
  const lineNumbers = Array.from({ length: bodyLineCount }, (_, index) => sourceLines.length - bodyLineCount + index);
  let title = '';
  let environment: Parameters<typeof parser.parse>[1] = {};
  let tokens = parser.parse(body, environment);
  const heading = tokens.findIndex((token) => token.type === 'heading_open' && token.tag === 'h1' && token.level === 0);
  if (heading >= 0) {
    const token = tokens[heading];
    if (containsImage(tokens[heading + 1]?.children ?? [])) {
      throw imageError(tokens.slice(heading, matchingClose(tokens, heading) + 1), sourceLines, lineNumbers);
    }
    title = plainInline(tokens[heading + 1]?.children ?? []).trim();
    if (title && token?.map) {
      const lines = body.split('\n');
      lines.splice(token.map[0], token.map[1] - token.map[0]);
      lineNumbers.splice(token.map[0], token.map[1] - token.map[0]);
      body = lines.join('\n');
      environment = {};
      tokens = parser.parse(body, environment);
    }
  }
  title ||= (filename.split(/[\\/]/).pop() ?? filename).replace(/\.md$/i, '') || 'Untitled';
  const lines = body.split('\n');
  const blocks: ContentBlock[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    const end = token.nesting === 1 ? matchingClose(tokens, index) : index;
    let native: ContentBlock[] | null = null;
    if (token.type === 'paragraph_open') native = nativeInline(tokens[index + 1]?.children ?? [], 'unstyled');
    else if (token.type === 'heading_open') {
      native = nativeInline(tokens[index + 1]?.children ?? [], token.tag === 'h1' ? 'header-one' : 'header-two');
    } else if (token.type === 'ordered_list_open' || token.type === 'bullet_list_open') native = nativeList(tokens, index, end);
    else if (token.type === 'blockquote_open') native = nativeQuote(tokens, index, end);
    if (native) blocks.push(...native);
    else if (containsImage(tokens.slice(index, end + 1))) {
      throw imageError(tokens.slice(index, end + 1), sourceLines, lineNumbers);
    } else if (token.map) blocks.push({ type: 'markdown', markdown: preserveReferences(lines.slice(token.map[0], token.map[1]).join('\n'), tokens.slice(index, end + 1), environment) });
    else if (token.content) blocks.push({ type: 'markdown', markdown: token.content });
    else throw new Error(`Cannot preserve Markdown token: ${token.type}`);
    index = end;
  }
  return { title, body, blocks };
}

function validateRange(text: string, range: Pick<TextLink, 'offset' | 'length'>): void {
  if (!Number.isInteger(range.offset) || !Number.isInteger(range.length) || range.offset < 0 || range.length <= 0
    || range.offset + range.length > text.length) throw new Error('Invalid text formatting range.');
  for (const boundary of [range.offset, range.offset + range.length]) {
    // A range must contain an entire code point, even though X counts UTF-16 units.
    const current = text.charCodeAt(boundary), previous = text.charCodeAt(boundary - 1);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) throw new Error('Invalid text formatting range: split Unicode character.');
  }
}

function normalizedLinks(block: TextBlock): TextLink[] {
  const links = block.links.map(link => {
    validateRange(block.text, link);
    const url = link.url.trim();
    if (!url || [...url].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
      || /^(javascript|vbscript|data):/i.test(url)) throw new Error('文章链接包含不安全或无效的地址。');
    return { ...link, url };
  }).sort((left, right) => left.offset - right.offset || left.length - right.length);
  const normalized: TextLink[] = [];
  for (const link of links) {
    const previous = normalized.at(-1);
    if (previous && link.offset < previous.offset + previous.length && link.url !== previous.url) throw new Error('同一段文字存在重叠且目标不同的链接。');
    if (previous && link.url === previous.url && link.offset <= previous.offset + previous.length) {
      previous.length = Math.max(previous.length, link.offset + link.length - previous.offset);
    } else normalized.push(link);
  }
  return normalized;
}

/** Convert to the observed X article DraftJS wire format. Offsets use UTF-16. */
export function serializeContent(blocks: ContentBlock[], media: Map<string, UploadedMedia>): XContent {
  const content: XContent = { blocks: [], entity_map: [] };
  const addEntity = (type: string, mutability: string, data: Record<string, unknown>): number => {
    const key = content.entity_map.length;
    content.entity_map.push({ key: String(key), value: { type, mutability, data } });
    return key;
  };
  const addBlock = (type: string, text: string, inlineStyles: TextStyle[] = [], entityRanges: XContent['blocks'][number]['entity_ranges'] = []): void => {
    content.blocks.push({ key: content.blocks.length.toString(36).padStart(5, '0'), type, text, data: {}, entity_ranges: entityRanges, inline_style_ranges: inlineStyles });
  };
  for (const block of blocks) {
    if (block.type === 'text') {
      const ranges = normalizedLinks(block).map((link) => {
        return { key: addEntity('LINK', 'Mutable', { url: link.url }), offset: link.offset, length: link.length };
      });
      for (const style of block.styles) {
        validateRange(block.text, style);
        if (!['Bold', 'Italic', 'Strikethrough'].includes(style.style)) throw new Error('不支持的文字样式。');
      }
      addBlock(block.kind, block.text, block.styles.map((style) => ({ ...style })), ranges);
    } else if (block.type === 'image') {
      const uploaded = media.get(block.source);
      if (!uploaded?.id || !uploaded.localId || !uploaded.category) throw new Error(`Image has not been uploaded: ${block.source}`);
      const key = addEntity('MEDIA', 'Immutable', {
        ...(uploaded.entityKey ? { entity_key: uploaded.entityKey } : {}),
        media_items: [{ media_id: uploaded.id, local_media_id: uploaded.localId, media_category: uploaded.category }],
      });
      addBlock('atomic', ' ', [], [{ key, offset: 0, length: 1 }]);
    } else {
      const markdown = `${block.markdown.startsWith('\n') ? '' : '\n'}${block.markdown}${block.markdown.endsWith('\n') ? '' : '\n'}`;
      const key = addEntity('MARKDOWN', 'Mutable', { markdown });
      addBlock('atomic', ' ', [], [{ key, offset: 0, length: 1 }]);
    }
  }
  if (!content.blocks.length || content.blocks.at(-1)?.type === 'atomic') addBlock('unstyled', '');
  return content;
}
