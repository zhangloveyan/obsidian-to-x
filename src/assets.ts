import { requestUrl, TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { MediaAsset } from './model';
import { Buffer } from 'node:buffer';

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function resolveImage(app: App, source: string, notePath: string): TFile | null {
  return app.metadataCache.getFirstLinkpathDest(source, notePath);
}

export async function loadImage(app: App, source: string, notePath: string): Promise<MediaAsset> {
  let bytes: ArrayBuffer;
  let name: string;
  let mime: string;
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    const response = await requestUrl({ url: url.href, throw: false });
    if (response.status < 200 || response.status >= 300) throw new Error(`图片下载失败（${response.status}）：${source}`);
    bytes = response.arrayBuffer;
    name = url.pathname.split('/').pop() || 'image';
    mime = (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() || '';
  } else {
    const file = resolveImage(app, source, notePath);
    if (!(file instanceof TFile)) throw new Error(`找不到图片：${source}`);
    bytes = await app.vault.readBinary(file);
    name = file.name;
    mime = TYPES[file.extension.toLowerCase()] ?? '';
  }
  if (!Object.values(TYPES).includes(mime)) throw new Error(`不支持的图片格式：${name}。请使用 PNG、JPEG、GIF 或 WebP。`);
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`图片为空或超过 20 MB：${name}`);
  return { source, name, mime, base64: Buffer.from(bytes).toString('base64') };
}
