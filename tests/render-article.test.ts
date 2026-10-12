import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import type { ParsedNote } from '../src/model';
import { parseNote } from '../src/content/article';

interface Options { text?: string; cls?: string; attr?: Record<string, string>; }
class Element {
  children: Array<Element | string> = [];
  constructor(readonly tag: string, readonly options: Options = {}) { if (options.text) this.children.push(options.text); }
  empty(): void { this.children = []; }
  createEl(tag: string, options: Options = {}): Element { const child = new Element(tag, options); this.children.push(child); return child; }
  createDiv(options: Options): Element { return this.createEl('div', options); }
  appendText(text: string): void { this.children.push(text); }
  append(value: Element | string): void { this.children.push(value); }
  get text(): string { return this.children.map(child => typeof child === 'string' ? child : child.text).join(''); }
  elements(tag: string): Element[] { return this.children.flatMap(child => typeof child === 'string' ? [] : [...(child.tag === tag ? [child] : []), ...child.elements(tag)]); }
}

const renderer = (async () => {
  const bundle = await build({
    entryPoints: ['src/ui/render-article.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'render-host', setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
      builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ loader: 'js', contents: 'export const sanitizeHTMLToDom = html => html;' }));
      builder.onLoad({ filter: /[\\/]assets\.ts$/ }, () => ({ loader: 'js', contents: 'export const resolveImage = (app, source) => app.metadataCache.getFirstLinkpathDest(source);' }));
    } }],
  });
  const module = { exports: {} as { renderArticle(app: unknown, root: Element, note: ParsedNote, path: string): void } };
  runInContext(bundle.outputFiles[0]!.text, createContext({ module }));
  return module.exports.renderArticle;
})();
const app = { metadataCache: { getFirstLinkpathDest: (source: string) => source === 'missing.png' ? null : { path: source } }, vault: { getResourcePath: (file: { path: string }) => `fixture:${file.path}` } };

test('adjacent Markdown images stack as separate blocks without a whitespace paragraph', async () => {
  const render = await renderer;
  for (const separator of ['\n', '\n\n', ' ']) {
    const root = new Element('article');
    const note = parseNote(`![[first.png]]${separator}![[second.png]]`, 'fixture.md');
    const before = structuredClone(note.blocks);
    render(app, root, note, 'fixture.md');
    assert.equal(root.elements('p').length, 0);
    assert.deepEqual(root.elements('img').map(image => image.options.attr?.src), ['fixture:first.png', 'fixture:second.png']);
    assert.equal(root.elements('div').filter(element => element.options.cls === 'mxp-image-block').length, 2);
    assert.deepEqual(note.blocks, before, 'Rendering must not alter saved note content');
  }
});

test('real text and its line breaks between images remain visible', async () => {
  const root = new Element('article');
  const note = parseNote('![[first.png]]\n\n真实说明 **保留加粗**\n下一行\n\n![[second.png]]', 'fixture.md');
  (await renderer)(app, root, note, 'fixture.md');
  assert.equal(root.elements('p').length, 1);
  assert.equal(root.elements('p')[0]?.text, '真实说明 保留加粗\n下一行');
  assert.equal(root.elements('strong')[0]?.text, '保留加粗');
  assert.equal(root.elements('img').length, 2);
});

test('formatted whitespace and missing-image diagnostics are not silently discarded', async () => {
  const root = new Element('article');
  const note: ParsedNote = { title: 'Fixture', cover: '', body: '', blocks: [
    { type: 'text', kind: 'unstyled', text: ' ', styles: [{ style: 'Bold', offset: 0, length: 1 }], links: [] },
    { type: 'image', source: 'missing.png', alt: 'Missing' },
  ] };
  (await renderer)(app, root, note, 'fixture.md');
  assert.equal(root.elements('strong')[0]?.text, ' ');
  assert.match(root.elements('p')[1]!.text, /找不到图片：missing\.png/);
});
