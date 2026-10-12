import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';
import { classifyDiagnosticError, DiagnosticLog, sanitizeDiagnostic } from '../src/diagnostics';

function host(initial = ''): { app: App; saved(): string; writes: string[] } {
  let value = initial;
  const writes: string[] = [];
  const app = { vault: { adapter: {
    stat: async () => value ? { type: 'file', size: new TextEncoder().encode(value).length } : null,
    read: async () => value,
    exists: async () => true,
    mkdir: async () => undefined,
    write: async (path: string, text: string) => { writes.push(path); value = text; },
  } } } as unknown as App;
  return { app, saved: () => value, writes };
}

test('logs stage statistics while excluding note data, credentials and raw error messages', async () => {
  const storage = host();
  const log = new DiagnosticLog(storage.app, '.obsidian/plugins/markdown-x-publisher');
  log.start('save');
  log.record('media.wait', { index: 3, total: 5, elapsedMs: 30000, ready: false,
    title: 'Private article', filepath: 'C:\\private\\note.md', token: 'top-secret', base64: 'encoded-image', content: 'Private body' });
  log.fail('media.bind', new Error('等待图片绑定超时：页面尚未准备好 https://x.com/?token=secret Private article'));
  await log.flush();
  assert.match(log.text(), /index=3 total=5 elapsedMs=30000 ready=false/);
  assert.match(log.text(), /media_bind_timeout/);
  for (const secret of ['Private article', 'Private body', 'top-secret', 'encoded-image', 'secret', 'note.md']) assert.ok(!storage.saved().includes(secret));
  assert.deepEqual([...new Set(storage.writes)], ['.obsidian/plugins/markdown-x-publisher/logs/latest.log']);
});

test('sanitizes embedded URL queries, credential assignments, long values and local paths', () => {
  assert.equal(sanitizeDiagnostic('Authorization: Bearer opaque'), '[敏感信息已隐藏]');
  assert.equal(sanitizeDiagnostic('token=opaque'), '[敏感信息已隐藏]');
  assert.equal(sanitizeDiagnostic('{"Authorization":"private-header"}'), '[敏感信息已隐藏]');
  assert.equal(sanitizeDiagnostic('{"password":"private-value"}'), '[敏感信息已隐藏]');
  assert.ok(!sanitizeDiagnostic('https://example.com/path?private=value#fragment').includes('private'));
  assert.ok(!sanitizeDiagnostic('stage C:\\Users\\Private User\\secret.txt').includes('Private User'));
  assert.ok(!sanitizeDiagnostic('stage /home/private/secret.txt').includes('/home/private'));
  assert.ok(!sanitizeDiagnostic('A'.repeat(300)).includes('A'.repeat(32)));
  assert.equal(classifyDiagnosticError(new Error('private arbitrary message')).code, 'operation_failed');
  assert.equal(classifyDiagnosticError(new Error('HTTP 403 rejected')).httpStatus, 403);
  assert.equal(classifyDiagnosticError(new Error('MCP error -32000: Connection closed')).code, 'transport_closed');
  assert.equal(classifyDiagnosticError(new Error('ReadBuffer exceeded maximum size of 10485760 bytes')).code, 'transport_message_too_large');
  assert.equal(classifyDiagnosticError(new Error('第 4 张图片上传失败：mediaId timeout')).code, 'media_upload_timeout');
  assert.equal(classifyDiagnosticError(new Error('MXP_MEDIA_UPLOAD_TIMEOUT: 第 4 张图片等待 180 秒仍未完成上传')).code, 'media_upload_timeout');
  assert.equal(classifyDiagnosticError(new Error('保存后图片占位符重新出现，正文尚未完整保存。')).code, 'media_relocation_unstable');
  assert.equal(classifyDiagnosticError(new Error('MXP_RELOCATION_UNSTABLE: 图片位置尚未稳定')).code, 'media_relocation_unstable');
  assert.equal(classifyDiagnosticError(new Error('第 3 张图片上传失败：multiple new media identities; upload source is ambiguous')).code, 'media_identity_ambiguous');
  assert.equal(classifyDiagnosticError(new Error('MXP_MEDIA_IDENTITY_AMBIGUOUS: 无法区分上传图片')).code, 'media_identity_ambiguous');
});

test('keeps the first actionable failure category inside a later wait timeout', () => {
  const result = classifyDiagnosticError(new Error('等待新建文章入口超时：### Error\nError: MXP_CREATE_AMBIGUOUS: 未找到唯一的新建文章入口（找到 2 个），请打开 X 文章列表。'));
  assert.equal(result.code, 'create_entry_ambiguous');
  assert.equal(result.count, 2);
  assert.equal(classifyDiagnosticError(new Error('MXP_CREATE_AMBIGUOUS: 找到 2 个新建文章入口，无法确定安全的创建按钮。')).count, 2);
  assert.equal(classifyDiagnosticError(new Error('未找到新建文章入口，请等待 X 文章列表加载完成。')).code, 'create_entry_missing');
  assert.equal(classifyDiagnosticError(new Error('未找到唯一的新建文章入口（找到 0 个）')).code, 'create_entry_missing');
  assert.equal(classifyDiagnosticError(new Error('ReferenceError: privateVariable is not defined')).code, 'page_script_reference');
});

test('keeps history within both byte and entry limits, including multibyte text', async () => {
  const storage = host();
  const log = new DiagnosticLog(storage.app, '.obsidian/plugins/markdown-x-publisher');
  log.start('save');
  for (let index = 0; index < 1400; index++) log.record('media.wait', { index, stage: '图片等待阶段'.repeat(40) });
  await log.flush();
  assert.ok(new TextEncoder().encode(storage.saved()).length <= 128 * 1024);
  assert.ok(storage.saved().trim().split('\n').length <= 1000);
  assert.match(log.text(), /index=1399/);
});

test('reloads valid history, resanitizes fields, and clears persisted history', async () => {
  const storage = host(`${JSON.stringify({ time: new Date().toISOString(), event: 'media.wait', details: { count: 5, token: 'unsafe-history', stage: 'upload' } })}\ninvalid line\n`);
  const log = new DiagnosticLog(storage.app, '.obsidian/plugins/markdown-x-publisher');
  await log.init();
  assert.match(log.text(), /count=5/);
  assert.ok(!log.text().includes('unsafe-history'));
  const first = log.text();
  await log.init();
  assert.equal(log.text(), first);
  await log.clear();
  assert.equal(log.text(), '');
  assert.equal(storage.saved(), '');
});

test('storage failures and invalid external destinations cannot fail the upload flow', async () => {
  const storage = host();
  storage.app.vault.adapter.write = async () => { throw new Error('disk unavailable'); };
  storage.app.vault.adapter.stat = async () => { throw new Error('disk unavailable'); };
  const log = new DiagnosticLog(storage.app, '.obsidian/plugins/markdown-x-publisher');
  await log.init();
  log.record('started');
  await assert.doesNotReject(log.flush());
  await assert.doesNotReject(log.clear());
  for (const path of ['../outside', '/outside', 'C:\\outside']) {
    const external = new DiagnosticLog(storage.app, path);
    external.record('started');
    await external.flush();
  }
  assert.deepEqual(storage.writes, []);
});

test('pending history load cannot replace a newly started operation', async () => {
  const storage = host();
  let release: (() => void) | undefined;
  storage.app.vault.adapter.stat = async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { type: 'file', size: 100, ctime: 0, mtime: 0 };
  };
  storage.app.vault.adapter.read = async () => JSON.stringify({ time: new Date().toISOString(), event: 'old', details: {} });
  const log = new DiagnosticLog(storage.app, '.obsidian/plugins/markdown-x-publisher');
  const loading = log.init();
  log.start('connection');
  release?.();
  await loading;
  await log.flush();
  assert.match(log.text(), /operation=connection/);
  assert.ok(!log.text().includes(' old'));
});
