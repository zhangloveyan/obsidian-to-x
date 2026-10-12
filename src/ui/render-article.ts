import MarkdownIt from 'markdown-it';
import { sanitizeHTMLToDom } from 'obsidian';
import type { App } from 'obsidian';
import type { ParsedNote, ContentBlock } from '../model';
import { resolveImage } from '../assets';

const markdown = new MarkdownIt({ html: false, linkify: false });

function renderText(parent: HTMLElement, block: Extract<ContentBlock, { type: 'text' }>): void {
  const boundaries = new Set([0, block.text.length]);
  for (const range of [...block.styles, ...block.links]) { boundaries.add(range.offset); boundaries.add(range.offset + range.length); }
  const points = [...boundaries].sort((a, b) => a - b);
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index]!, end = points[index + 1]!;
    let container = parent;
    const link = block.links.find(link => link.offset <= start && link.offset + link.length >= end);
    if (link && /^(https?:|mailto:)/i.test(link.url)) {
      container = container.createEl('a', { href: link.url, attr: { target: '_blank', rel: 'noopener noreferrer' } });
    }
    for (const style of block.styles.filter(style => style.offset <= start && style.offset + style.length >= end)) {
      container = container.createEl(style.style === 'Bold' ? 'strong' : style.style === 'Italic' ? 'em' : 'del');
    }
    container.appendText(block.text.slice(start, end));
  }
}

/** Render the same parsed blocks that are sent to X, without running other plugins' code blocks. */
export function renderArticle(app: App, root: HTMLElement, note: ParsedNote, notePath: string): void {
  root.empty();
  root.createEl('h1', { text: note.title });
  let list: HTMLElement | null = null;
  let listKind = '';
  for (const block of note.blocks) {
    if (block.type === 'text') {
      // A soft break between inline Markdown images becomes its own text block.
      // It separates the source images, but is not a visible blank paragraph.
      if (block.kind === 'unstyled' && !block.text.trim() && !block.styles.length && !block.links.length) {
        list = null;
        continue;
      }
      const ordered = block.kind === 'ordered-list-item';
      const isList = ordered || block.kind === 'unordered-list-item';
      if (isList) {
        if (!list || listKind !== block.kind) { list = root.createEl(ordered ? 'ol' : 'ul'); listKind = block.kind; }
        renderText(list.createEl('li', { cls: 'mxp-text' }), block);
      } else {
        list = null;
        const tag = block.kind === 'header-one' ? 'h1' : block.kind === 'header-two' ? 'h2' : block.kind === 'blockquote' ? 'blockquote' : 'p';
        renderText(root.createEl(tag, { cls: 'mxp-text' }), block);
      }
    } else {
      list = null;
      if (block.type === 'markdown') {
        root.createDiv({ cls: 'mxp-markdown-block' }).append(sanitizeHTMLToDom(markdown.render(block.markdown)));
      } else {
        const file = resolveImage(app, block.source, notePath);
        const src = /^https?:\/\//i.test(block.source) ? block.source : file ? app.vault.getResourcePath(file) : '';
        if (src) root.createDiv({ cls: 'mxp-image-block' }).createEl('img', { attr: { src, alt: block.alt } });
        else root.createEl('p', { cls: 'mxp-help', text: `找不到图片：${block.source}` });
      }
    }
  }
}
