import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';

class Control {
  clicked = 0;
  inMain = true;
  type = 'button';
  disabled = false;
  width = 40;
  height = 32;
  display = 'block';
  visibility = 'visible';
  draftAncestor = false;
  constructor(readonly tagName: 'BUTTON' | 'A', readonly textContent = '', readonly attributes: Record<string, string> = {}) {}
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return { width: this.width, height: this.height }; }
  closest(selector: string) {
    assert.equal(selector, 'a[href*="/articles/edit/"]');
    return this.draftAncestor ? {} : null;
  }
  click(): void { this.clicked++; }
}

const compiled = (async () => {
  const bundle = await build({ entryPoints: ['src/browser/article-controls.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'es2022', minify: false, write: false });
  const module = { exports: {} as { createArticleDraft(): { previous: string[] } } };
  runInContext(bundle.outputFiles[0]!.text, createContext({ module }));
  return module.exports.createArticleDraft.toString();
})();

async function create(controls: Control[], location = { hostname: 'x.com', pathname: '/compose/articles' }) {
  const document = {
    querySelectorAll(selector: string) {
      if (selector === 'main button[aria-label="create"]') {
        return controls.filter(control => control.inMain && control.tagName === 'BUTTON' && control.getAttribute('aria-label') === 'create');
      }
      assert.equal(selector, 'a[href]');
      return controls.filter(control => control.tagName === 'A' && control.getAttribute('href') !== null);
    },
  };
  const context = createContext({ location, document, getComputedStyle: (control: Control) => ({ display: control.display, visibility: control.visibility }) });
  // Execute the emitted function in a fresh page realm with no host closures.
  return runInContext(`(${await compiled})()`, context) as { previous: string[] };
}

const createButton = (text = '') => new Control('BUTTON', text, { 'aria-label': 'create' });

test('serialized create action uses the observed label regardless of visible language and records existing drafts before clicking', async () => {
  for (const text of ['', '撰写', 'Créer', '新規', '글 작성']) {
    const button = createButton(text);
    const draft = new Control('A', 'Existing article', { href: '/compose/articles/edit/123' });
    const outsideDraft = new Control('A', 'Earlier article', { href: 'https://x.com/compose/articles/edit/456?from=list' });
    outsideDraft.inMain = false;
    const unrelated = new Control('A', '', { href: '/compose/articles/edit/123invalid' });
    button.click = () => {
      button.clicked++;
      draft.attributes.href = '/compose/articles/edit/999';
    };
    const result = await create([button, draft, outsideDraft, unrelated]);
    assert.deepEqual([...result.previous], ['123', '456']);
    assert.equal(button.clicked, 1);
    assert.equal(draft.clicked, 0);
    assert.equal(outsideDraft.clicked, 0);
  }
});

test('translated text, unknown labels, compose links and SVG-only controls cannot create an article', async () => {
  const controls = [
    ...['Create', '撰写', 'Créer', '新規', '글 작성'].map(text => new Control('BUTTON', text)),
    new Control('BUTTON', 'Write', { 'aria-label': 'compose' }),
    new Control('BUTTON', '', { 'aria-label': '创建' }),
    new Control('BUTTON', '', { 'aria-label': 'Create' }),
    new Control('A', '撰写', { 'data-testid': 'empty_state_button_text', href: '/compose/articles' }),
    new Control('A', '', { role: 'button', 'aria-label': 'create' }),
  ];
  const iconOnly = new Control('BUTTON');
  Object.assign(iconOnly, { querySelectorAll: () => [{ getAttribute: () => 'M0 0h24v24' }] });
  controls.push(iconOnly);
  await assert.rejects(() => create(controls), /未找到新建文章入口.*等待/);
  assert.ok(controls.every(control => control.clicked === 0));
});

test('multiple usable create buttons are rejected before any click', async () => {
  const first = createButton(), second = createButton('撰写');
  await assert.rejects(() => create([first, second]), /MXP_CREATE_AMBIGUOUS.*2/);
  assert.deepEqual([first.clicked, second.clicked], [0, 0]);
});

test('unavailable controls, buttons outside main and controls inside draft links are excluded', async () => {
  const disabled = createButton(); disabled.disabled = true;
  const ariaDisabled = createButton(); ariaDisabled.attributes['aria-disabled'] = 'true';
  const hidden = createButton(); hidden.display = 'none';
  const invisible = createButton(); invisible.visibility = 'hidden';
  const collapsed = createButton(); collapsed.visibility = 'collapse';
  const zeroWidth = createButton(); zeroWidth.width = 0;
  const zeroHeight = createButton(); zeroHeight.height = 0;
  const submit = createButton(); submit.type = 'submit';
  const reset = createButton(); reset.type = 'reset';
  const outside = createButton(); outside.inMain = false;
  const inDraft = createButton(); inDraft.draftAncestor = true;
  const excluded = [disabled, ariaDisabled, hidden, invisible, collapsed, zeroWidth, zeroHeight, submit, reset, outside, inDraft];
  const valid = createButton();
  await create([...excluded, valid]);
  assert.equal(valid.clicked, 1);
  assert.ok(excluded.every(control => control.clicked === 0));
  await assert.rejects(() => create(excluded), /未找到新建文章入口/);
  assert.ok(excluded.every(control => control.clicked === 0));
});

test('a different site or route never clicks an otherwise valid create control', async () => {
  for (const location of [
    { hostname: 'example.com', pathname: '/compose/articles' },
    { hostname: 'x.com.example.com', pathname: '/compose/articles' },
    { hostname: 'x.com', pathname: '/home' },
    { hostname: 'x.com', pathname: '/compose/articles/edit/123' },
  ]) {
    const button = createButton();
    await assert.rejects(() => create([button], location), /MXP_PAGE_CHANGED/);
    assert.equal(button.clicked, 0);
  }
});
