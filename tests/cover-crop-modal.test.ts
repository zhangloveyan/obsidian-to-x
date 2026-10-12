import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import type { MediaAsset } from '../src/model';
import type { CoverSelection } from '../src/ui/cover-selection';

const DOM_SELECTION = { rangeCount: 0, anchorNode: null };

// Only the controls created before image preparation are needed here.
class ElementStub {
  disabled = false;
  textContent = '';
  createEl(): ElementStub { return new ElementStub(); }
  createDiv(): ElementStub { return new ElementStub(); }
  empty(): void {}
  addClass(): void {}
  addEventListener(): void {}
  setText(text: string): void { this.textContent = text; }
}

class ModalStub {
  contentEl = new ElementStub();
  modalEl = new ElementStub();
  selection: unknown;
  constructor(public app: object) {}
  setTitle(): void {}
  onOpen(): void {}
  open(): void {
    // Obsidian saves the current DOM text selection in this runtime field.
    // A subclass constructor property called "selection" is overwritten.
    this.selection = DOM_SELECTION;
    this.onOpen();
  }
}

const bundle = build({
  entryPoints: ['src/ui/cover-crop-modal.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  loader: { '.css': 'text' },
  plugins: [{ name: 'crop-modal-input-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ loader: 'js', contents: `
      export const Modal = globalThis.ModalStub;
      export const setIcon = () => {};
    ` }));
    builder.onLoad({ filter: /[\\/]assets\.ts$/ }, () => ({ loader: 'js', contents: `
      export async function loadImage(app, source, notePath) {
        globalThis.loads.push({app,source,notePath});
        return globalThis.loadedAsset;
      }
    ` }));
    builder.onLoad({ filter: /[\\/]ui[\\/]cover-crop-image\.ts$/ }, () => ({ loader: 'js', contents: `
      export async function prepareCoverImage(asset) {
        globalThis.prepared.push(asset);
        throw new Error('Stop after observing the image input');
      }
      export async function encodeCroppedCover() { throw new Error('Unexpected encoding'); }
    ` }));
  } }],
});

async function openModal(selection: CoverSelection) {
  const app = { name: 'fixture app' };
  const loads: Array<{ app: object; source: string; notePath: string }> = [];
  const prepared: MediaAsset[] = [];
  const loadedAsset: MediaAsset = { source: selection.source, name: 'article.png', mime: 'image/png', base64: 'article' };
  const context = createContext({ module: { exports: {} }, ModalStub, loads, prepared, loadedAsset });
  runInContext((await bundle).outputFiles[0]!.text, context);
  const CropModal = context.module.exports.CoverCropModal as new (app: object, selection: CoverSelection, notePath: string, apply: () => void) => ModalStub;
  const modal = new CropModal(app, selection, 'notes/article.md', () => assert.fail('Input-only preparation must not apply a crop'));
  modal.open();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(modal.selection, DOM_SELECTION, 'the host really overwrites its selection field during open');
  assert.equal(prepared.length, 1, 'image preparation is reached after opening');
  return { app, loads, prepared, loadedAsset };
}

test('Modal.open text selection cannot replace a chosen local cover asset', async () => {
  const asset: MediaAsset = { source: 'local-cover:one', name: 'local.png', mime: 'image/png', base64: 'local' };
  const host = await openModal({ source: asset.source, asset });
  assert.equal(host.loads.length, 0, 'an in-memory local cover must never be resolved as a note path');
  assert.equal(host.prepared[0], asset);
});

test('re-cropping preserves the original asset despite Modal.open overwriting selection', async () => {
  const original: MediaAsset = { source: 'local-cover:original', name: 'original.gif', mime: 'image/gif', base64: 'original' };
  const asset: MediaAsset = { source: 'cropped-cover:one', name: 'original-cover.png', mime: 'image/png', base64: 'cropped' };
  const host = await openModal({ source: asset.source, asset, crop: { original, data: { x: 0, y: 0, width: 1000, height: 400 } } });
  assert.equal(host.loads.length, 0);
  assert.equal(host.prepared[0], original, 're-cropping starts from the original, not the previous cropped PNG');
});

test('article cover source and note path survive Modal.open text selection capture', async () => {
  const host = await openModal({ source: 'attachments/article.png' });
  assert.equal(host.loads.length, 1);
  assert.equal(host.loads[0]?.app, host.app);
  assert.equal(host.loads[0]?.source, 'attachments/article.png');
  assert.equal(host.loads[0]?.notePath, 'notes/article.md');
  assert.equal(host.prepared[0], host.loadedAsset);
});
