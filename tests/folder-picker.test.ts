import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';

const compiled = build({
  entryPoints: ['src/ui/folder-picker.ts'], bundle: true, platform: 'node',
  format: 'cjs', target: 'es2022', write: false,
  external: ['electron', '@electron/remote'],
}).then(result => result.outputFiles[0]!.text);

async function picker(modules: Record<string, unknown>) {
  const requested: string[] = [];
  const module = { exports: {} as { chooseRuntimeFolder(title: string, path: string): Promise<string | null> } };
  runInContext(await compiled, createContext({
    module,
    require(name: string) {
      requested.push(name);
      if (!(name in modules)) throw new Error(`Module unavailable: ${name}`);
      return modules[name];
    },
  }));
  assert.deepEqual(requested, [], 'loading the plugin must not resolve Electron modules');
  return { choose: module.exports.chooseRuntimeFolder, requested };
}

function nativeDialog(result: { canceled: boolean; filePaths: string[] }) {
  const window = {};
  const calls: Array<{ parent: object; options: Record<string, unknown> }> = [];
  const remote = {
    getCurrentWindow: () => window,
    dialog: {
      async showOpenDialog(parent: object, options: Record<string, unknown>) {
        calls.push({ parent, options });
        return result;
      },
    },
  };
  return { window, calls, remote };
}

test('selects a single native directory attached to the current Obsidian window', async () => {
  const native = nativeDialog({ canceled: false, filePaths: ['D:\\工具\\Node.js'] });
  const host = await picker({ electron: { remote: native.remote } });
  assert.equal(await host.choose('选择 Node.js 文件夹', 'D:\\工具'), 'D:\\工具\\Node.js');
  assert.deepEqual(host.requested, ['electron']);
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0]?.parent, native.window);
  assert.equal(native.calls[0]?.options.title, '选择 Node.js 文件夹');
  assert.equal(native.calls[0]?.options.defaultPath, 'D:\\工具');
  assert.deepEqual(Array.from(native.calls[0]?.options.properties as string[]), ['openDirectory']);
});

test('falls back to the host remote module and leaves an empty default path unspecified', async () => {
  for (const electron of [{}, { remote: { dialog: {} } }]) {
    const native = nativeDialog({ canceled: false, filePaths: ['/opt/node'] });
    const host = await picker({ electron, '@electron/remote': native.remote });
    assert.equal(await host.choose('选择文件夹', ''), '/opt/node');
    assert.deepEqual(host.requested, ['electron', '@electron/remote']);
    assert.equal(Object.hasOwn(native.calls[0]!.options, 'defaultPath'), false);
  }
  const native = nativeDialog({ canceled: false, filePaths: ['/opt/node'] });
  const host = await picker({ '@electron/remote': native.remote });
  assert.equal(await host.choose('选择文件夹', ''), '/opt/node');
});

test('canceling or receiving no selection returns null without opening another dialog', async () => {
  for (const result of [
    { canceled: true, filePaths: [] },
    { canceled: true, filePaths: ['D:\\ignored'] },
    { canceled: false, filePaths: [] },
  ]) {
    const native = nativeDialog(result);
    const host = await picker({ electron: { remote: native.remote } });
    assert.equal(await host.choose('选择文件夹', ''), null);
    assert.equal(native.calls.length, 1);
    assert.deepEqual(host.requested, ['electron']);
  }
});

test('unavailable or failed native dialogs report a picker problem without blaming the installation', async () => {
  const missing = await picker({});
  await assert.rejects(missing.choose('选择文件夹', ''), /无法打开系统文件夹选择窗口/);
  const native = nativeDialog({ canceled: false, filePaths: [] });
  native.remote.dialog.showOpenDialog = async () => { throw new Error('private native error'); };
  const failing = await picker({ electron: { remote: native.remote } });
  await assert.rejects(failing.choose('选择文件夹', ''), (error: unknown) => {
    assert.ok(error !== null && typeof error === 'object' && 'message' in error);
    assert.equal(error.message, '无法打开系统文件夹选择窗口。请重试，或直接填写文件夹路径。');
    return true;
  });
  assert.deepEqual(failing.requested, ['electron'], 'a failed dialog must not open a second picker');
});
