import { Buffer } from 'node:buffer';
import type { MediaAsset } from '../model';

export interface CoverCropData { x: number; y: number; width: number; height: number; }
export interface CoverSelection {
  source: string;
  asset?: MediaAsset;
  crop?: { original: MediaAsset; data: CoverCropData };
}
export const MAX_COVER_BYTES = 20 * 1024 * 1024;

interface LocalImageFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function imageMime(bytes: Uint8Array): string | undefined {
  const matches = (signature: number[], offset = 0): boolean => signature.every((value, index) => bytes[offset + index] === value);
  if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (matches([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matches([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || matches([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
  if (matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

/** Read a user-chosen file into memory; selecting a cover never uploads it. */
export async function readLocalCover(file: LocalImageFile): Promise<MediaAsset> {
  if (!file.size || file.size > MAX_COVER_BYTES) throw new Error('图片为空或超过 20 MB，请重新选择。');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!extension || !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片。');
  const buffer = await file.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_COVER_BYTES) throw new Error('图片为空或超过 20 MB，请重新选择。');
  const bytes = new Uint8Array(buffer);
  const mime = imageMime(bytes);
  if (!mime) throw new Error('文件不是有效的 PNG、JPEG、GIF 或 WebP 图片。');
  const expected = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
  if (mime !== expected || (file.type && file.type.toLowerCase() !== mime)) throw new Error('图片格式与文件类型不一致，请使用原始图片文件。');
  return { source: `local-cover:${crypto.randomUUID()}`, name: file.name, mime, base64: Buffer.from(buffer).toString('base64') };
}
