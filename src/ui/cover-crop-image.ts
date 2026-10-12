import { Buffer } from 'node:buffer';
import type { MediaAsset } from '../model';
import { MAX_COVER_BYTES } from './cover-selection';

function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob || !blob.size || blob.type !== 'image/png') reject(new Error('封面图片编码失败，请重新选择图片。'));
      else resolve(blob);
    }, 'image/png');
  });
}

/** The caller owns the returned URL and must revoke it after use. */
export async function prepareCoverImage(asset: MediaAsset): Promise<{ asset: MediaAsset; url: string; width: number; height: number }> {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mime)) throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片。');
  const bytes = Uint8Array.from(Buffer.from(asset.base64, 'base64'));
  if (!bytes.byteLength || bytes.byteLength > MAX_COVER_BYTES) throw new Error('图片为空或超过 20 MB，请重新选择。');
  let bitmap: ImageBitmap;
  try {
    // HTML's Blob decoding algorithm selects the default image / first frame,
    // independently of animation playback: https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-createimagebitmap
    bitmap = await createImageBitmap(new Blob([bytes], { type: asset.mime }));
  } catch {
    throw new Error('图片无法解码，文件可能已损坏，请重新选择。');
  }
  let canvas: HTMLCanvasElement | undefined;
  let png: Blob;
  const { width, height } = bitmap;
  try {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('图片尺寸无效，请重新选择。');
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建图片画布，请重试。');
    context.drawImage(bitmap, 0, 0);
    png = await encodePng(canvas);
  } finally {
    bitmap.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
  // No object URL exists during decoding/encoding, so failed awaits cannot
  // leak one. The original asset remains available for subsequent re-crops.
  return { asset, url: URL.createObjectURL(png), width, height };
}

/** Encode a caller-owned crop canvas without changing the original asset. */
export async function encodeCroppedCover(canvas: HTMLCanvasElement, original: MediaAsset): Promise<MediaAsset> {
  const { width, height } = canvas;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * 2 !== height * 5 || width > 2560) {
    throw new Error('封面裁剪尺寸无效，请使用 5:2 比例且宽度不超过 2560 像素。');
  }
  const png = await encodePng(canvas);
  if (png.size > MAX_COVER_BYTES) throw new Error('裁剪后的封面超过 20 MB，请缩小图片后重试。');
  const bytes = await png.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_COVER_BYTES) throw new Error('裁剪后的封面为空或超过 20 MB，请重新选择。');
  const filename = original.name.split(/[\\/]/).pop() || 'image';
  const stem = filename.replace(/\.[^.]*$/, '') || 'image';
  return { source: `cropped-cover:${crypto.randomUUID()}`, name: `${stem}-cover.png`, mime: 'image/png', base64: Buffer.from(bytes).toString('base64') };
}
