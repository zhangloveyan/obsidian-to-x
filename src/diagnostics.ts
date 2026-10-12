import type { App } from 'obsidian';

type Detail = string | number | boolean | null;
interface Entry { time: string; event: string; details: Record<string, Detail>; }
const MAX_BYTES = 128 * 1024;
const MAX_ENTRIES = 1000;
const encoder = new TextEncoder();
const STRING_FIELDS = new Set(['stage', 'operation', 'tool', 'code', 'reason', 'mime', 'kind', 'state', 'status', 'version', 'nodeVersion', 'mcpVersion', 'type', 'action', 'format']);
const PRIVATE_KEY = /token|secret|password|authorization|cookie|header|base64|payload|filename|filepath/i;

export function sanitizeDiagnostic(value: string): string {
  if (/\b(?:token|password|secret|cookie|authorization|api[-_]?key)\b["']?\s*[:=]|bearer\s+|data:[^,]*;base64,/i.test(value)) return '[敏感信息已隐藏]';
  return value.replace(/https?:\/\/[^\s<>"']+/gi, address => {
    try { return `${new URL(address).origin}/[地址已简化]`; } catch { return '[地址已隐藏]'; }
  }).replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n]*/gi, '[文件路径已隐藏]')
    .replace(/\/(?:Users|home|tmp|var|private|opt)\/[^\r\n]*/g, '[文件路径已隐藏]')
    .replace(/[a-z\d_+/=-]{32,}/gi, '[长值已隐藏]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 240);
}

function safeDetails(input: Record<string, Detail>): Record<string, Detail> {
  const result: Record<string, Detail> = {};
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    if (!/^[a-z][a-z\d_]{0,47}$/i.test(key) || PRIVATE_KEY.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean' || value === null) result[key] = value;
    else if (typeof value === 'string' && STRING_FIELDS.has(key)) result[key] = sanitizeDiagnostic(value);
  }
  return result;
}

/** Error messages can contain article data or credentials; only return known categories. */
export function classifyDiagnosticError(error: unknown): { code: string; reason: string; httpStatus?: number; count?: number } {
  let message = '';
  try { message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''; } catch { /* Do not inspect arbitrary error objects. */ }
  const createCount = /未找到唯一的新建文章入口（找到 (\d+) 个）/.exec(message)?.[1]
    ?? /MXP_CREATE_AMBIGUOUS:\s*找到 (\d+) 个新建文章入口/.exec(message)?.[1];
  if (createCount !== undefined) {
    const count = Number(createCount);
    return { code: count > 1 ? 'create_entry_ambiguous' : 'create_entry_missing', reason: count > 1 ? '页面存在多个新建文章入口，尚未创建草稿' : '尚未找到新建文章入口', count };
  }
  const categories: Array<[RegExp, string, string]> = [
    [/ReadBuffer exceeded maximum size|MCP_MESSAGE_TOO_LARGE/, 'transport_message_too_large', '浏览器连接消息超过 MCP 缓冲区限制'],
    [/Connection closed|MCP_CONNECTION_CLOSED|\bEPIPE\b|Not connected/i, 'transport_closed', '浏览器连接中断，操作未完成'],
    [/未找到新建文章入口/, 'create_entry_missing', '尚未找到新建文章入口，页面可能仍在加载'],
    [/\bReferenceError:/, 'page_script_reference', '浏览器脚本引用了不可用的对象'],
    [/\bSyntaxError:/, 'page_script_syntax', '浏览器脚本语法不受支持'],
    [/\bTypeError:/, 'page_script_type', '浏览器页面数据与预期格式不一致'],
    [/图片绑定.*超时|image.*bind.*time/i, 'media_bind_timeout', '等待图片绑定超时'],
    [/MXP_MEDIA_UPLOAD_TIMEOUT|图片上传.*(?:超时|timeout)|mediaId timeout|image.*upload.*time/i, 'media_upload_timeout', '等待确认图片上传结果超时'],
    [/MXP_MEDIA_IDENTITY_AMBIGUOUS|multiple new media identities|图片标识对应不同来源|无法唯一对应上传图片/, 'media_identity_ambiguous', '图片已出现在编辑器，但无法唯一确认本次上传对应的图片'],
    [/MXP_MEDIA_STATE_UNSTABLE/, 'media_state_unstable', '已确认图片的编辑器状态尚未恢复或保存绑定未完成'],
    [/MXP_RELOCATION_UNSTABLE|保存后图片(?:占位符重新出现|位置发生变化)|图片位置尚未稳定/, 'media_relocation_unstable', 'X 保存后正文图片位置回滚，重排核对未通过'],
    [/unref is not a function/i, 'transport_timer', '浏览器连接关闭时出现计时器兼容错误'],
    [/token|连接凭据|authentication|unauthori[sz]ed/i, 'connection_auth', '浏览器连接凭据未通过验证或连接未就绪'],
    [/登录|log.?in|sign.?in/i, 'login_required', 'X 登录状态需要检查'],
    [/MXP_PAGE_CHANGED|页面已离开|浏览器已离开/i, 'page_changed', '页面离开了本次草稿'],
    [/超时|time.?out|timed out/i, 'timeout', '操作等待超时'],
    [/核对|不一致|verify|mismatch/i, 'verification_failed', '保存结果核对未通过'],
    [/图片|image|media/i, 'media_error', '图片读取、上传或绑定未完成'],
    [/node\.js|playwright mcp|缺少必要工具|运行环境/i, 'runtime_unavailable', '本地浏览器运行环境未就绪'],
    [/network|fetch|网络|ECONN|ENOTFOUND/i, 'network_error', '网络请求未完成'],
    [/停用|取消|abort|cancel/i, 'cancelled', '操作已取消'],
  ];
  const match = categories.find(([pattern]) => pattern.test(message));
  const http = /\b(?:HTTP|status)\s*[:=(]?\s*([1-5]\d{2})\b/i.exec(message);
  return {
    code: match?.[1] ?? 'operation_failed', reason: match?.[2] ?? '操作未完成；请结合此前阶段和状态排查',
    ...(http?.[1] ? { httpStatus: Number(http[1]) } : {}),
  };
}

/** Local, bounded diagnostics. Storage failures never reject the caller's operation. */
export class DiagnosticLog {
  private entries: Entry[] = [];
  private serialized: string[] = [];
  private bytes = 0;
  private revision = 0;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private directory: string | undefined;
  private file: string | undefined;

  constructor(private app: App, pluginDir: string) {
    const path = pluginDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (path && !path.startsWith('/') && !path.includes(':') && !path.split('/').some(part => part === '..' || part === '.')) {
      this.directory = `${path}/logs`;
      this.file = `${this.directory}/latest.log`;
    }
  }

  async init(): Promise<void> {
    const revision = this.revision;
    if (!this.file) return;
    try {
      const adapter = this.app.vault.adapter;
      const info = await adapter.stat(this.file);
      if (!info || info.type !== 'file' || info.size > MAX_BYTES) return;
      const text = await adapter.read(this.file);
      if (revision !== this.revision) return;
      this.entries = [];
      this.serialized = [];
      this.bytes = 0;
      for (const line of text.split('\n').slice(-MAX_ENTRIES - 1)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Partial<Entry>;
          if (typeof entry.time !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(entry.time) || typeof entry.event !== 'string') continue;
          if (!entry.details || typeof entry.details !== 'object' || Array.isArray(entry.details)) continue;
          this.append({ time: entry.time, event: sanitizeDiagnostic(entry.event).slice(0, 100), details: safeDetails(entry.details) });
        } catch { /* Ignore malformed or foreign log entries. */ }
      }
    } catch { /* Diagnostics are best effort. */ }
  }

  start(operation: 'save' | 'connection'): void {
    this.entries = [];
    this.serialized = [];
    this.bytes = 0;
    this.record('operation.started', { operation });
  }

  record(event: string, details: Record<string, Detail> = {}): void {
    try {
      ++this.revision;
      this.append({ time: new Date().toISOString(), event: sanitizeDiagnostic(event).slice(0, 100), details: safeDetails(details) });
      if (this.pending === undefined) this.pending = setTimeout(() => { this.pending = undefined; void this.flush(); }, 300);
    } catch { /* A diagnostic event must not interrupt a save. */ }
  }

  fail(stage: string, error: unknown): void {
    this.record('operation.failed', { stage, ...classifyDiagnosticError(error) });
  }

  text(): string {
    return this.entries.map(entry => {
      const details = Object.entries(entry.details).map(([key, value]) => `${key}=${String(value)}`).join(' ');
      return `${entry.time} ${entry.event}${details ? ` | ${details}` : ''}`;
    }).join('\n');
  }

  flush(): Promise<void> {
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = undefined;
    const directory = this.directory;
    const file = this.file;
    if (!directory || !file) return Promise.resolve();
    const text = this.serialized.length ? `${this.serialized.join('\n')}\n` : '';
    this.writes = this.writes.then(async () => {
      const adapter = this.app.vault.adapter;
      if (!await adapter.exists(directory)) await adapter.mkdir(directory);
      await adapter.write(file, text);
    }).catch(() => undefined);
    return this.writes;
  }

  async clear(): Promise<void> {
    ++this.revision;
    this.entries = [];
    this.serialized = [];
    this.bytes = 0;
    await this.flush();
  }

  private append(entry: Entry): void {
    const line = JSON.stringify(entry);
    this.entries.push(entry);
    this.serialized.push(line);
    this.bytes += encoder.encode(`${line}\n`).byteLength;
    while (this.entries.length > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      this.entries.shift();
      const discarded = this.serialized.shift();
      if (discarded !== undefined) this.bytes -= encoder.encode(`${discarded}\n`).byteLength;
    }
  }
}
