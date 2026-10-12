import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { MediaAsset } from '../src/model';
import { encodeCroppedCover, prepareCoverImage } from '../src/ui/cover-crop-image';
import { MAX_COVER_BYTES } from '../src/ui/cover-selection';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQmcAAAAASUVORK5CYII=', 'base64');
const asset: MediaAsset = { source: 'note/image.gif', name: 'image.gif', mime: 'image/gif', base64: 'R0lGODlh' };
const pngBlob = (): Blob => new Blob([PNG], { type: 'image/png' });

function replaceGlobal(t: TestContext, key: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { value, configurable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
}

function canvas(blob: Blob | null = pngBlob(), width = 1000, height = 400): HTMLCanvasElement {
  return { width, height, toBlob(callback: BlobCallback, type: string) { assert.equal(type, 'image/png'); queueMicrotask(() => callback(blob)); } } as HTMLCanvasElement;
}

test('preparation freezes a Blob-decoded frame as PNG and preserves the original for re-cropping', async t => {
  let closes = 0;
  const inputBlobs: Blob[] = [];
  const bitmap = { width: 800, height: 600, close: () => { closes++; } };
  const output = canvas();
  const drawImage = t.mock.fn((image: unknown) => assert.equal(image, bitmap));
  output.getContext = (() => ({ drawImage })) as unknown as typeof output.getContext;
  replaceGlobal(t, 'createImageBitmap', async (blob: Blob) => { inputBlobs.push(blob); return bitmap; });
  replaceGlobal(t, 'document', { createElement: (tag: string) => { assert.equal(tag, 'canvas'); return output; } });
  const urls = t.mock.method(URL, 'createObjectURL', (blob: Blob) => { assert.equal(closes, inputBlobs.length); assert.equal(blob.type, 'image/png'); return 'blob:static-preview'; });
  const revoke = t.mock.method(URL, 'revokeObjectURL');
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const original = Object.freeze({ ...asset, mime });
    const prepared = await prepareCoverImage(original);
    assert.equal(prepared.asset, original);
    assert.deepEqual({ width: prepared.width, height: prepared.height, url: prepared.url }, { width: 800, height: 600, url: 'blob:static-preview' });
    assert.equal(inputBlobs.at(-1)?.type, mime);
    assert.equal(Buffer.from(await inputBlobs.at(-1)!.arrayBuffer()).toString('base64'), original.base64);
  }
  assert.equal(closes, 4);
  assert.equal(drawImage.mock.callCount(), 4);
  assert.equal(urls.mock.callCount(), 4);
  assert.equal(revoke.mock.callCount(), 0, 'successful URL lifetime belongs to the caller');
  assert.equal(output.width, 0);
  assert.equal(output.height, 0);
});

test('decode and asynchronous PNG failures leave no preview URL or live bitmap', async t => {
  let closes = 0;
  let decodeFails = true;
  const urls = t.mock.method(URL, 'createObjectURL');
  replaceGlobal(t, 'createImageBitmap', async () => {
    if (decodeFails) throw new Error('bad image');
    return { width: 20, height: 8, close: () => { closes++; } };
  });
  await assert.rejects(prepareCoverImage(asset), /无法解码/);
  decodeFails = false;
  const output = canvas(null);
  output.getContext = (() => ({ drawImage() {} })) as unknown as typeof output.getContext;
  replaceGlobal(t, 'document', { createElement: () => output });
  await assert.rejects(prepareCoverImage(asset), /编码失败/);
  assert.equal(closes, 1);
  assert.equal(urls.mock.callCount(), 0);
  assert.equal(output.width, 0);
  assert.equal(output.height, 0);
});

test('cropped output has independent identity, PNG bytes and filename without mutating its original', async () => {
  const original = Object.freeze({ ...asset, name: '目录/我的封面.v2.webp', mime: 'image/webp' });
  const first = await encodeCroppedCover(canvas(), original);
  const second = await encodeCroppedCover(canvas(), original);
  assert.equal(first.name, '我的封面.v2-cover.png');
  assert.equal(first.mime, 'image/png');
  assert.equal(first.base64, PNG.toString('base64'));
  assert.match(first.source, /^cropped-cover:[a-f0-9-]+$/);
  assert.notEqual(first.source, second.source);
  assert.equal(original.source, asset.source);
  assert.equal(original.base64, asset.base64);
});

test('invalid proportions, excessive dimensions, encoding failures and oversized PNGs cannot be selected', async () => {
  for (const [width, height] of [[0, 0], [1000, 401], [2565, 1026]]) {
    await assert.rejects(encodeCroppedCover(canvas(null, width, height), asset), /裁剪尺寸无效/);
  }
  await assert.rejects(encodeCroppedCover(canvas(null), asset), /编码失败/);
  await assert.rejects(encodeCroppedCover(canvas(new Blob([PNG], { type: 'image/jpeg' })), asset), /编码失败/);
  await assert.rejects(encodeCroppedCover(canvas(new Blob([new Uint8Array(MAX_COVER_BYTES + 1)], { type: 'image/png' })), asset), /超过 20 MB/);
});

test('empty, oversized and unsupported originals fail before decoding', async t => {
  const decode = t.mock.fn();
  replaceGlobal(t, 'createImageBitmap', decode);
  await assert.rejects(prepareCoverImage({ ...asset, mime: 'image/svg+xml' }), /请选择 PNG/);
  await assert.rejects(prepareCoverImage({ ...asset, base64: '' }), /为空或超过 20 MB/);
  await assert.rejects(prepareCoverImage({ ...asset, base64: Buffer.alloc(MAX_COVER_BYTES + 1).toString('base64') }), /为空或超过 20 MB/);
  assert.equal(decode.mock.callCount(), 0);
});
