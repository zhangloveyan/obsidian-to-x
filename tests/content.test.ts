import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArticleImageError, parseNote, serializeContent } from '../src/content/article';
import type { ContentBlock, UploadedMedia } from '../src/model';

function asText(block: ContentBlock | undefined): Extract<ContentBlock, { type: 'text' }> {
  assert.equal(block?.type, 'text');
  return block as Extract<ContentBlock, { type: 'text' }>;
}

test('note properties cannot set the title, select a cover or enter the article body', () => {
  const note = parseNote('---\ntitle: "元数据标题"\ncover: "![[素材/封面.png|600]]"\nother: value\n---\n# 正文标题\n\n正文', 'fallback.md');
  assert.equal(note.title, '正文标题');
  assert.equal('cover' in note, false);
  assert.equal(asText(note.blocks[0]).text, '正文');
  assert.equal(note.body.trim(), '正文');
  const wire = JSON.stringify(serializeContent(note.blocks, new Map()));
  assert.equal(wire.includes('元数据标题'), false);
  assert.equal(wire.includes('封面.png'), false);
  assert.equal(parseNote('---\ntitle: Ignored\ncover: ignored.png\n---\nBody', 'Filename.md').title, 'Filename');
});

test('first top-level H1 becomes title, with filename fallback and later H1 retained', () => {
  const note = parseNote('开场\n\n# **标题** 😀\n\n# 后续\n\n## 二级', 'unused.md');
  assert.equal(note.title, '标题 😀');
  assert.equal(note.body.includes('**标题**'), false);
  assert.deepEqual(note.blocks.map((block) => asText(block).kind), ['unstyled', 'header-one', 'header-two']);
  assert.equal(parseNote('普通正文', 'C:\\notes\\文章.MD').title, '文章');
  assert.equal(parseNote('> # 引用标题', '文件.md').title, '文件');
});

test('UTF-16 styles, combinations and links retain exact Chinese and emoji positions', () => {
  const note = parseNote('中😀 **粗😀** *斜* ~~删~~ ***合😀*** [链😀](https://example.com)', 'note.md');
  const block = asText(note.blocks[0]);
  assert.equal(block.text, '中😀 粗😀 斜 删 合😀 链😀');
  assert.deepEqual(block.styles, [
    { offset: 4, length: 3, style: 'Bold' },
    { offset: 8, length: 1, style: 'Italic' },
    { offset: 10, length: 1, style: 'Strikethrough' },
    { offset: 12, length: 3, style: 'Italic' },
    { offset: 12, length: 3, style: 'Bold' },
  ]);
  assert.deepEqual(block.links, [{ offset: 16, length: 3, url: 'https://example.com' }]);
  const content = serializeContent(note.blocks, new Map());
  assert.deepEqual(content.blocks[0]?.entity_ranges, [{ key: 0, offset: 16, length: 3 }]);
  assert.deepEqual(content.entity_map[0], { key: '0', value: { type: 'LINK', mutability: 'Mutable', data: { url: 'https://example.com' } } });
});

test('nested formats merge contiguous ranges without moving link offsets', () => {
  const block = asText(parseNote('**甲*乙*丙** [**😀字**](https://example.com)', 'note.md').blocks[0]);
  assert.equal(block.text, '甲乙丙 😀字');
  assert.deepEqual(block.styles, [
    { offset: 0, length: 3, style: 'Bold' },
    { offset: 1, length: 1, style: 'Italic' },
    { offset: 4, length: 3, style: 'Bold' },
  ]);
  assert.deepEqual(block.links, [{ offset: 4, length: 3, url: 'https://example.com' }]);
});

test('paragraph images retain order and styles restart correctly after each image', () => {
  const note = parseNote('**前😀 ![[folder/图.png|400]] 后**\n\n![远程](https://example.com/photo.png)\n\n末尾', 'note.md');
  assert.deepEqual(note.blocks.map((block) => block.type), ['text', 'image', 'text', 'image', 'text']);
  assert.deepEqual(note.blocks[1], { type: 'image', source: 'folder/图.png', alt: '图.png' });
  assert.deepEqual(asText(note.blocks[0]).styles, [{ offset: 0, length: 4, style: 'Bold' }]);
  assert.deepEqual(asText(note.blocks[2]).styles, [{ offset: 0, length: 2, style: 'Bold' }]);
  assert.deepEqual(note.blocks[3], { type: 'image', source: 'https://example.com/photo.png', alt: '远程' });
});

test('fenced code and GFM tables retain original Markdown and do not extract code images', () => {
  const fence = '```ts\nconst image = "![[secret.png]]";\nconst strong = "**literal**";\n```';
  const table = '| 中文 | value |\n| :--- | ---: |\n| 😀 | **bold** |';
  const note = parseNote(`${fence}\n\n${table}`, 'note.md');
  assert.deepEqual(note.blocks, [{ type: 'markdown', markdown: fence }, { type: 'markdown', markdown: table }]);
  const wire = serializeContent(note.blocks, new Map());
  assert.deepEqual(wire.entity_map.map((entity) => entity.value.type), ['MARKDOWN', 'MARKDOWN']);
  assert.deepEqual(wire.entity_map.map((entity) => entity.value.data['markdown']), [`\n${fence}\n`, `\n${table}\n`]);
  assert.equal(wire.entity_map[0]?.value.mutability, 'Mutable');
  assert.deepEqual(wire.blocks.map((block) => block.type), ['atomic', 'atomic', 'unstyled']);
});

test('ordered lists, unordered lists and quotes preserve order with adjacent images', () => {
  const note = parseNote('1. 第一 **粗体**\n2. 第二\n\n![[a.png]]\n\n> 引用\n\n- 项目甲\n- 项目乙', 'note.md');
  assert.deepEqual(note.blocks.map((block) => block.type === 'text' ? block.kind : block.type), [
    'ordered-list-item', 'ordered-list-item', 'image', 'blockquote', 'unordered-list-item', 'unordered-list-item',
  ]);
  assert.equal(asText(note.blocks[0]).text, '第一 粗体');
  assert.deepEqual(asText(note.blocks[0]).styles, [{ offset: 3, length: 2, style: 'Bold' }]);
});

test('list images use explicit numbers that survive serialization across image and continuation blocks', () => {
  const note = parseNote('1. before ![[a.png]] after\n2. next', 'note.md');
  assert.deepEqual(note.blocks.map(block => block.type === 'text' ? [block.kind, block.text] : block.type === 'image' ? [block.type, block.source] : [block.type, block.markdown]), [
    ['unstyled', '1. before '], ['image', 'a.png'], ['unstyled', ' after'], ['unstyled', '2. next'],
  ]);
  const wire = serializeContent(note.blocks, new Map([['a.png', { id: '123', localId: 'local-a', category: 'TweetImage' }]]));
  assert.deepEqual(wire.blocks.map(block => [block.type, block.text]), [
    ['unstyled', '1. before '], ['atomic', ' '], ['unstyled', ' after'], ['unstyled', '2. next'],
  ]);
  assert.equal(wire.entity_map[0]?.value.type, 'MEDIA');
});

test('list items keep multiple paragraphs, consecutive images and image-only first paragraphs in authored order', () => {
  const source = '1. **第一😀** [链接](https://example.com)\n\n   ![甲](a.png)\n\n   继续 *说明*\n\n   ![[b.png]]\n\n   ![[c.png]]\n\n2. 第二\n\n3. ![[d.png]]\n\n   图后说明';
  const note = parseNote(source, 'note.md');
  assert.deepEqual(note.blocks.map(block => block.type === 'text' ? block.text : block.type === 'image' ? `image:${block.source}` : 'markdown'), [
    '1. 第一😀 链接', 'image:a.png', '继续 说明', 'image:b.png', 'image:c.png', '2. 第二', '3. ', 'image:d.png', '图后说明',
  ]);
  const first = asText(note.blocks[0]);
  assert.deepEqual(first.styles, [{ offset: 3, length: 4, style: 'Bold' }]);
  assert.deepEqual(first.links, [{ offset: 8, length: 2, url: 'https://example.com' }]);
  assert.deepEqual(asText(note.blocks[2]).styles, [{ offset: 3, length: 2, style: 'Italic' }]);
  const media = new Map(['a', 'b', 'c', 'd'].map(name => [`${name}.png`, { id: name, localId: `local-${name}`, category: 'TweetImage' }]));
  const wire = serializeContent(note.blocks, media);
  assert.deepEqual(wire.blocks[0]?.entity_ranges, [{ key: 0, offset: 8, length: 2 }]);
  assert.deepEqual(wire.blocks[0]?.inline_style_ranges, first.styles);
  assert.deepEqual(wire.entity_map.filter(entity => entity.value.type === 'MEDIA').map(entity => entity.value.data.media_items), [
    [{ media_id: 'a', local_media_id: 'local-a', media_category: 'TweetImage' }],
    [{ media_id: 'b', local_media_id: 'local-b', media_category: 'TweetImage' }],
    [{ media_id: 'c', local_media_id: 'local-c', media_category: 'TweetImage' }],
    [{ media_id: 'd', local_media_id: 'local-d', media_category: 'TweetImage' }],
  ]);
  assert.equal(wire.blocks.some(block => block.type.includes('list-item')), false);
});

test('expanded unordered and non-default ordered lists retain markers without numbering continuation paragraphs', () => {
  for (const [source, texts] of [
    ['- first\n\n  more\n\n- second', ['• first', 'more', '• second']],
    ['- ![[a.png]]\n- **next**', ['• ', '• next']],
    ['9. first\n\n   ![[a.png]]\n\n10. [next](https://example.com)', ['9. first', '10. next']],
    ['3. first\n\n   more\n\n4. next', ['3. first', 'more', '4. next']],
  ] as const) {
    const note = parseNote(source, 'note.md');
    const text = note.blocks.filter(block => block.type === 'text');
    assert.deepEqual(text.map(block => block.text), texts, source);
    assert.ok(text.every(block => block.kind === 'unstyled'), source);
    if (source.includes('**next**')) assert.deepEqual(text.at(-1)?.styles, [{ offset: 2, length: 4, style: 'Bold' }]);
    if (source.includes('[next]')) assert.deepEqual(text.at(-1)?.links, [{ offset: 4, length: 4, url: 'https://example.com' }]);
  }
});

test('unsupported nested blocks and inline code remain Markdown', () => {
  for (const source of ['3. start at three\n4. next', '- top\n  - nested', 'before `![[inside.png]]` after', '> - nested quote', '---', '<div>raw HTML</div>']) {
    assert.deepEqual(parseNote(source, 'note.md').blocks, [{ type: 'markdown', markdown: source }], source);
  }
});

test('deeper headings fold into the second native heading level', () => {
  const note = parseNote('# Title\n\n## Two\n\n### Three\n\n###### Six', 'note.md');
  assert.deepEqual(note.blocks.map((block) => asText(block).kind), ['header-two', 'header-two', 'header-two']);
  assert.deepEqual(note.blocks.map((block) => asText(block).text), ['Two', 'Three', 'Six']);
});

test('images in fallback Markdown fail explicitly instead of creating incomplete drafts', () => {
  for (const source of ['- top\n  - ![[nested.png]]', '| image |\n| --- |\n| ![alt](local.png) |', '[![alt](photo.png)](https://example.com)', 'before `code` ![[local.png]]', '<img src="local.png">', '# Title ![[title.png]]']) {
    assert.throws(() => parseNote(source, 'note.md'), ArticleImageError, source);
  }
});

test('nested list image errors show the image paragraph and surrounding source instead of the list start', () => {
  const source = '## 使用\n\n1. 打开文章\n\n2. 打开 **预览**\n\n   - ![截图](preview.png)\n\n3. 保存草稿';
  assert.throws(() => parseNote(source, 'note.md'), (error: unknown) => {
    assert.ok(error instanceof ArticleImageError);
    assert.equal(error.location, '原文第 7 行 · 编号列表');
    assert.deepEqual(error.context, [
      { line: 5, text: '2. 打开 **预览**', highlighted: false },
      { line: 6, text: '', highlighted: false },
      { line: 7, text: '   - ![截图](preview.png)', highlighted: true },
      { line: 8, text: '', highlighted: false },
      { line: 9, text: '3. 保存草稿', highlighted: false },
    ]);
    assert.match(error.suggestion, /普通段落/);
    assert.match(error.suggestion, /仅增加空行/);
    return true;
  });
});

test('image diagnostics preserve original lines after properties and H1 removal without exposing comments', () => {
  const source = '\uFEFF---\r\ntitle: private property\r\n---\r\n# 标题\r\n\r\n%%private\r\ncomment%%\r\n\r\n- 说明 %%private inline%%\r\n\r\n  - ![[图.png]]';
  assert.throws(() => parseNote(source, 'note.md'), (error: unknown) => {
    assert.ok(error instanceof ArticleImageError);
    assert.equal(error.location, '原文第 11 行 · 无序列表');
    assert.equal(error.context[0]?.line, 9);
    assert.equal(error.context.at(-1)?.text, '  - ![[图.png]]');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});

test('table image errors use the image row and multiline paragraphs report a range', () => {
  for (const [source, location] of [
    ['# 标题\n\n| 图片 |\n| --- |\n| ![图](a.png) |', '原文第 5 行 · 表格'],
    ['文字 `代码`\n![图](a.png)', '原文第 1–2 行 · 图文混排段落'],
    ['# 标题 ![[封面.png]]', '原文第 1 行 · 标题'],
  ]) {
    assert.throws(() => parseNote(source!, 'note.md'), (error: unknown) => {
      assert.ok(error instanceof ArticleImageError);
      assert.equal(error.location, location);
      return true;
    });
  }
});

test('long problem paragraphs keep the actual image visible in their source context', () => {
  for (const source of [
    '前文 `代码`\n第二行\n第三行\n第四行\n第五行\n![图片](problem.png)',
    '<div>\n第二行\n第三行\n第四行\n第五行\n<img src="problem.png">\n</div>',
  ]) {
    assert.throws(() => parseNote(source, 'note.md'), (error: unknown) => {
      assert.ok(error instanceof ArticleImageError);
      assert.ok(error.context.some(row => row.highlighted && row.text.includes('problem.png')));
      return true;
    });
  }
});

test('fallback Markdown retains reference link definitions from other source lines', () => {
  const source = 'A `code` and [guide].\n\n[guide]: https://example.com "Guide title"';
  const note = parseNote(source, 'note.md');
  assert.deepEqual(note.blocks, [{ type: 'markdown', markdown: 'A `code` and [guide].\n\n[GUIDE]: <https://example.com> "Guide title"' }]);
});

test('escaped embeds are text and standard reference images are parsed', () => {
  const escaped = parseNote('\\![[not-image.png]]', 'note.md');
  assert.equal(asText(escaped.blocks[0]).text, '![[not-image.png]]');
  const reference = parseNote('![Alt][image]\n\n[image]: folder/image.png', 'note.md');
  assert.deepEqual(reference.blocks, [{ type: 'image', source: 'folder/image.png', alt: 'Alt' }]);
});

test('image paths decode Markdown destinations once while preserving wiki literal percent filenames', () => {
  const note = parseNote('![space](foo%20bar.png)\n\n![percent](foo%2520bar.png)\n\n![[foo%20bar.png|500]]\n\n![unicode](%E5%9B%BE.png)\n\n![remote](https://example.com/foo%2520bar.png)', 'note.md');
  assert.deepEqual(note.blocks.map((block) => block.type === 'image' ? block.source : ''), [
    'foo bar.png', 'foo%20bar.png', 'foo%20bar.png', '图.png', 'https://example.com/foo%2520bar.png',
  ]);
});

test('properties are skipped without YAML parsing and an unmatched delimiter remains article content', () => {
  for (const properties of ['title: [bad', 'cover: 123', '- item', 'title: One\ntitle: Two']) {
    const note = parseNote(`---\n${properties}\n---\ntext`, 'note.md');
    assert.equal(note.title, 'note');
    assert.equal(note.body, 'text');
  }
  assert.equal(parseNote('\uFEFF---\r\ntitle: Ignored\r\n...\r\ntext', 'note.md').body, 'text');
  assert.equal(parseNote('---\ntext', 'note.md').blocks[0]?.type, 'markdown');
});

test('hidden Obsidian and HTML comments are absent from both preview body and wire content', () => {
  const note = parseNote('# Public %%private title%% title\n\nPublic %%private inline%% text.\n\n%%\nprivate block\n\nprivate second paragraph\n%%\n\n<!--private HTML\n\nprivate HTML paragraph-->\n\nLast <!--private second HTML--> sentence. %%private last%%', 'note.md');
  const wire = serializeContent(note.blocks, new Map());
  assert.equal(note.title, 'Public  title');
  assert.equal(note.body.includes('private'), false);
  assert.equal(JSON.stringify(wire).includes('private'), false);
  assert.deepEqual(note.blocks.map((block) => asText(block).text), ['Public  text.', 'Last  sentence.']);
});

test('comment markers inside fenced, indented and inline code remain literal', () => {
  const fence = '```md\n%%literal fenced%%\n<!--literal HTML-->\n```';
  const inline = 'A `%%literal inline%%` and ``<!--literal ` HTML-->``.';
  const indented = '    %%literal indented%%\n    <!--literal indented HTML-->';
  const table = '| code |\n| --- |\n| `%%literal table%%` |';
  const note = parseNote(`${fence}\n\n${inline}\n\n${indented}\n\n${table}\n\nVisible %%private prose%%`, 'note.md');
  assert.deepEqual(note.blocks.slice(0, 4), [
    { type: 'markdown', markdown: fence }, { type: 'markdown', markdown: inline }, { type: 'markdown', markdown: indented }, { type: 'markdown', markdown: table },
  ]);
  assert.equal(note.body.includes('private'), false);
  assert.equal(note.body.includes('%%literal fenced%%'), true);
  assert.equal(asText(note.blocks[4]).text, 'Visible');
});

test('multiple comments with embedded fences cannot shield later private paragraphs', () => {
  const note = parseNote('%%\n```md\nprivate first\n%%\n\nPublic\n\n%%private second%%\n\n<!--private third-->\n\nEnd', 'note.md');
  assert.equal(note.body.includes('private'), false);
  assert.deepEqual(note.blocks.map((block) => asText(block).text), ['Public', 'End']);
  assert.equal(asText(parseNote('\\%%literal escaped\\%%', 'note.md').blocks[0]).text, '%%literal escaped%%');
});

test('unclosed or ambiguous multiline comments fail before preview or upload', () => {
  assert.throws(() => parseNote('Public\n\n%%private unfinished', 'note.md'), /注释未闭合/);
  assert.throws(() => parseNote('Public <!--private unfinished', 'note.md'), /注释未闭合/);
  assert.throws(() => parseNote('Public %%private\nsecond line%%', 'note.md'), /跨行 %% 注释需要从独立行开始/);
  assert.equal(parseNote('`unclosed-looking %% literal`', 'note.md').body, '`unclosed-looking %% literal`');
});

test('media wire format contains uploaded identity, immutable entity and editable trailing paragraph', () => {
  const media = new Map<string, UploadedMedia>([['a.png', { id: '1234567890123456789', localId: 'local-1', category: 'TweetImage', entityKey: 'uploaded-entity' }]]);
  const wire = serializeContent([{ type: 'image', source: 'a.png', alt: 'A' }], media);
  assert.deepEqual(wire.entity_map, [{ key: '0', value: { type: 'MEDIA', mutability: 'Immutable', data: {
    entity_key: 'uploaded-entity',
    media_items: [{ media_id: '1234567890123456789', local_media_id: 'local-1', media_category: 'TweetImage' }],
  } } }]);
  assert.deepEqual(wire.blocks[0]?.entity_ranges, [{ key: 0, offset: 0, length: 1 }]);
  assert.equal(wire.blocks[0]?.text, ' ');
  assert.equal(wire.blocks[1]?.text, '');
  assert.equal(wire.blocks[1]?.type, 'unstyled');
  assert.throws(() => serializeContent([{ type: 'image', source: 'missing.png', alt: '' }], media), /Image has not been uploaded: missing.png/);
});

test('serializer does not mutate input and rejects invalid text ranges', () => {
  const note = parseNote('**hello**', 'note.md');
  const before = JSON.stringify(note.blocks);
  const wire = serializeContent(note.blocks, new Map());
  assert.equal(JSON.stringify(note.blocks), before);
  assert.notEqual(wire.blocks[0]?.inline_style_ranges, asText(note.blocks[0]).styles);
  assert.equal(serializeContent([], new Map()).blocks[0]?.type, 'unstyled');
  assert.throws(() => serializeContent([{ type: 'text', kind: 'unstyled', text: 'a', styles: [{ style: 'Bold', offset: 0, length: 3 }], links: [] }], new Map()), /Invalid text formatting range/);
});

test('wire serialization rejects executable link URLs and split Unicode ranges', () => {
  const block = (): Extract<ContentBlock, { type: 'text' }> => ({ type: 'text', kind: 'unstyled', text: '甲😀乙', styles: [], links: [] });
  for (const url of ['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'java\nscript:alert(1)', 'vbscript:run()', 'data:text/html,test', '']) {
    const value = block(); value.links.push({ url, offset: 0, length: 4 });
    assert.throws(() => serializeContent([value], new Map()), /不安全或无效/);
  }
  for (const range of [{ offset: 1, length: 1 }, { offset: 2, length: 1 }]) {
    const value = block(); value.styles.push({ ...range, style: 'Bold' });
    assert.throws(() => serializeContent([value], new Map()), /split Unicode/);
    value.styles = []; value.links.push({ ...range, url: 'https://example.com' });
    assert.throws(() => serializeContent([value], new Map()), /split Unicode/);
  }
  const valid = block(); valid.styles.push({ offset: 1, length: 2, style: 'Bold' });
  assert.equal(serializeContent([valid], new Map()).blocks[0]?.text, '甲😀乙');
});

test('wire links merge compatible overlaps, reject conflicting ones, and preserve plain markup as data', () => {
  const value: Extract<ContentBlock, { type: 'text' }> = {
    type: 'text', kind: 'unstyled', text: '<script>hello</script>', styles: [],
    links: [{ offset: 0, length: 4, url: 'https://one.example' }, { offset: 2, length: 4, url: 'https://one.example' }],
  };
  const original = structuredClone(value);
  const content = serializeContent([value, { type: 'markdown', markdown: '<img onerror=alert(1)>' }], new Map());
  assert.equal(content.blocks[0]?.text, value.text);
  assert.deepEqual(content.blocks[0]?.entity_ranges, [{ key: 0, offset: 0, length: 6 }]);
  assert.equal(content.entity_map[1]?.value.data.markdown, '\n<img onerror=alert(1)>\n');
  assert.deepEqual(value, original);
  value.links[1]!.url = 'https://two.example';
  assert.throws(() => serializeContent([value], new Map()), /目标不同/);
});
