import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_COVER_BYTES, readLocalCover } from '../src/ui/cover-selection';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZQmcAAAAASUVORK5CYII=', 'base64');

function file(name: string, bytes: Uint8Array, type = '') {
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}

test('local cover selection stages image bytes without exposing a filesystem path', async () => {
  const first = await readLocalCover(file('图片.PNG', PNG, 'image/png'));
  const second = await readLocalCover(file('图片.PNG', PNG));
  assert.equal(first.name, '图片.PNG');
  assert.equal(first.mime, 'image/png');
  assert.equal(first.base64, PNG.toString('base64'));
  assert.match(first.source, /^local-cover:[a-f0-9-]+$/);
  assert.notEqual(first.source, second.source);
});

test('supported formats are detected from bytes rather than trusting the extension', async () => {
  for (const [name, bytes, mime] of [
    ['image.jpeg', [0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    ['image.gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'image/gif'],
    ['image.webp', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 'image/webp'],
  ] as const) {
    assert.equal((await readLocalCover(file(name, Uint8Array.from(bytes)))).mime, mime);
  }
  await assert.rejects(readLocalCover(file('pretend.png', new TextEncoder().encode('not an image'), 'image/png')), /不是有效的/);
  await assert.rejects(readLocalCover(file('wrong.jpg', PNG, 'image/jpeg')), /格式与文件类型不一致/);
  await assert.rejects(readLocalCover(file('file.svg', PNG)), /请选择 PNG/);
});

test('empty and oversized selections fail before reading and actual bytes are size checked', async () => {
  let reads = 0;
  const unread = { name: 'image.png', type: 'image/png', arrayBuffer: async () => { reads++; return new ArrayBuffer(1); } };
  await assert.rejects(readLocalCover({ ...unread, size: 0 }), /为空或超过 20 MB/);
  await assert.rejects(readLocalCover({ ...unread, size: MAX_COVER_BYTES + 1 }), /为空或超过 20 MB/);
  assert.equal(reads, 0);
  await assert.rejects(readLocalCover({ ...unread, size: 8, arrayBuffer: async () => new ArrayBuffer(MAX_COVER_BYTES + 1) }), /为空或超过 20 MB/);
});
