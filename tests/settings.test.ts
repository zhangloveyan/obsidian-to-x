import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { RuntimeDetection, RuntimePaths } from '../src/browser/discovery';

interface ElementOptions { text?: string; cls?: string; type?: string; attr?: Record<string, string>; }
type TestResult = 'testing' | 'passed' | 'failed' | null;

class ElementStub {
  children: ElementStub[] = [];
  text = '';
  value = '';
  disabled = false;
  hidden = false;
  title = '';
  readonly classes = new Set<string>();
  readonly attributes: Record<string, string>;
  readonly classList = {
    add: (...names: string[]) => { for (const name of names) this.classes.add(name); },
    remove: (...names: string[]) => { for (const name of names) this.classes.delete(name); },
  };
  onclick: ((event: { preventDefault(): void }) => unknown) | undefined;
  oninput: (() => unknown) | undefined;

  constructor(public tag = 'div', options: ElementOptions = {}) {
    this.text = options.text ?? '';
    this.attributes = { ...options.attr };
    for (const name of options.cls?.split(' ') ?? []) if (name) this.classes.add(name);
  }
  createEl(tag: string, options?: ElementOptions): ElementStub {
    const child = new ElementStub(tag, options); this.children.push(child); return child;
  }
  createDiv(options?: ElementOptions): ElementStub { return this.createEl('div', options); }
  createSpan(options?: ElementOptions): ElementStub { return this.createEl('span', options); }
  addClass(name: string): void { this.classes.add(name); }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  empty(): void { this.children = []; this.text = ''; }
  setText(text: string): void { this.empty(); this.text = text; }
  click(): unknown { if (!this.disabled) return this.onclick?.({ preventDefault() {} }); }
  enter(value: string): void {
    assert.equal(this.disabled, false, 'The edited field must be available to the user');
    this.value = value; this.oninput?.();
  }
  find(predicate: (element: ElementStub) => boolean): ElementStub | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find(predicate); if (found) return found; }
    return undefined;
  }
  all(predicate: (element: ElementStub) => boolean): ElementStub[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap(child => child.all(predicate))];
  }
}

class ToggleStub {
  value = false;
  disabled = false;
  onChange(_callback: (value: boolean) => unknown): this { return this; }
  setValue(value: boolean): this { this.value = value; return this; }
  setDisabled(disabled: boolean): this { this.disabled = disabled; return this; }
}

class SettingStub {
  readonly settingEl: ElementStub;
  readonly controlEl: ElementStub;
  private readonly name: ElementStub;
  constructor(root: ElementStub) {
    this.settingEl = root.createDiv();
    this.name = this.settingEl.createDiv();
    this.controlEl = this.settingEl.createDiv();
  }
  setName(name: string): this { this.name.setText(name); return this; }
  setHeading(): this { return this; }
  setClass(name: string): this { this.settingEl.addClass(name); return this; }
  setDesc(description: string): this { this.settingEl.createDiv({ text: description }); return this; }
  addToggle(callback: (toggle: ToggleStub) => unknown): this { callback(new ToggleStub()); return this; }
}

class PluginSettingTabStub {
  containerEl = new ElementStub();
}

const bundle = build({
  absWorkingDir: resolve('.'), entryPoints: ['src/settings.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'settings-event-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ loader: 'js', contents: `
      export const PluginSettingTab = globalThis.host.PluginSettingTab;
      export const Setting = globalThis.host.Setting;
      export class Notice { constructor(message) { globalThis.notices.push(message); } }
      export const setIcon = () => {};
    ` }));
    builder.onLoad({ filter: /[\\/]browser[\\/]discovery\.ts$/ }, () => ({ loader: 'js', contents: `
      export const cleanRuntimeDirectory = value => value.trim();
      export const detectRuntime = paths => globalThis.host.detectRuntime(paths);
    ` }));
    builder.onLoad({ filter: /[\\/]browser[\\/]extension\.ts$/ }, () => ({ loader: 'js', contents: `
      export const detectChromeExtension = () => globalThis.host.detectExtension();
    ` }));
    builder.onLoad({ filter: /[\\/]browser[\\/]runtime\.ts$/ }, () => ({ loader: 'js', contents: `
      export const normalizeToken = value => value.trim();
    ` }));
    builder.onLoad({ filter: /[\\/]ui[\\/]folder-picker\.ts$/ }, () => ({ loader: 'js', contents: `
      export const chooseRuntimeFolder = async () => null;
    ` }));
  } }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const savedPaths: RuntimePaths = { nodePath: 'D:/Tools/node', mcpPath: 'D:/Tools/mcp' };
function available(paths: RuntimePaths = savedPaths): RuntimeDetection {
  const node = paths.nodePath || savedPaths.nodePath, mcp = paths.mcpPath || savedPaths.mcpPath;
  return {
    node: { directory: node, path: `${node}/node.exe`, version: 'v22.14.0' },
    mcp: { directory: mcp, path: `${mcp}/cli.js`, version: '0.0.83' }, issues: [],
  };
}
const settle = (): Promise<void> => new Promise(done => setImmediate(done));

async function harness(options: { configured?: boolean; busy?: boolean; result?: TestResult; token?: string } = {}) {
  const calls = { runtime: [] as RuntimePaths[], extension: 0, saves: [] as RuntimePaths[], secretSaves: 0, connections: 0 };
  const control = {
    runtime: async (paths: RuntimePaths): Promise<RuntimeDetection> => available(paths),
    extension: async (): Promise<{ found: boolean }> => ({ found: true }),
    persist: async (_paths: RuntimePaths): Promise<void> => {},
    connect: async (): Promise<void> => {},
    result: options.result ?? null as TestResult,
    token: options.token ?? 'synthetic-test-token',
  };
  const timers = new Map<number, () => void>();
  const notices: string[] = [];
  let nextTimer = 0;
  const publisher = {
    manifest: { name: 'Markdown X Publisher', version: '0.1.19' },
    settings: { ...(options.configured === false ? { nodePath: '', mcpPath: '' } : savedPaths), secretName: 'synthetic-secret', autoPreview: true },
    busy: options.busy ?? false,
    register(_cleanup: () => void) {},
    connectionSettings: () => ({ ...publisher.settings, token: control.token }),
    connectionTestResult: (): TestResult => control.result,
    showSetup() {}, showDiagnostics() {},
    async saveAutoPreview(value: boolean) { publisher.settings.autoPreview = value; },
    async saveRuntimePaths(paths: RuntimePaths) {
      calls.saves.push({ ...paths }); publisher.busy = true;
      try { await control.persist(paths); publisher.settings = { ...publisher.settings, ...paths }; }
      finally { publisher.busy = false; }
    },
    async saveConnectionToken(value: string) { calls.secretSaves++; control.token = value.trim(); },
    async testConnection() {
      calls.connections++; publisher.busy = true; control.result = 'testing';
      try { await control.connect(); control.result = 'passed'; }
      catch (error) { control.result = 'failed'; throw error; }
      finally { publisher.busy = false; }
    },
  };
  const context = createContext({
    module: { exports: {} }, require: createRequire(import.meta.url), console, notices,
    host: {
      PluginSettingTab: PluginSettingTabStub, Setting: SettingStub,
      detectRuntime: (paths: RuntimePaths) => { calls.runtime.push({ ...paths }); return control.runtime(paths); },
      detectExtension: () => { calls.extension++; return control.extension(); },
    },
    window: {
      setInterval: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
      clearInterval: (id: number) => { timers.delete(id); },
    },
  });
  runInContext((await bundle).outputFiles[0]!.text, context);
  const tab = new context.module.exports.PublisherSettingTab({}, publisher) as {
    containerEl: ElementStub; display(): void; hide(): void;
  };
  const required = (predicate: (element: ElementStub) => boolean): ElementStub => {
    const element = tab.containerEl.find(predicate); assert.ok(element, 'Expected control exists'); return element;
  };
  return {
    tab, publisher, control, calls, notices,
    node: () => required(element => element.attributes['aria-label'] === 'Node.js 安装文件夹'),
    mcp: () => required(element => element.attributes['aria-label'] === 'Playwright MCP 安装文件夹'),
    token: () => required(element => element.attributes['aria-label'] === '连接密钥'),
    button: (name: string) => required(element => element.tag === 'button' && element.text === name),
    summary: () => required(element => element.classes.has('mxp-runtime-summary')).text,
    testStatus: () => required(element => element.classes.has('mxp-test-status')).text,
    badges: () => tab.containerEl.all(element => element.classes.has('mxp-runtime-badge')).map(element => element.text),
    errors: () => tab.containerEl.all(element => element.classes.has('mxp-runtime-error') && !element.hidden).map(element => element.text),
    tick: () => { for (const callback of [...timers.values()]) callback(); },
    timerCount: () => timers.size,
  };
}

test('first use stays empty until explicit detection, which fills paths without saving or touching token edits', async () => {
  const h = await harness({ configured: false, token: '' });
  h.tab.display();
  h.tick(); await settle(); h.tick();
  assert.equal(h.node().value, ''); assert.equal(h.mcp().value, '');
  assert.equal(h.calls.runtime.length, 0); assert.equal(h.calls.extension, 0);
  h.token().enter('unsaved-synthetic-token');
  h.button('自动检测').click(); await settle();
  assert.deepEqual(h.calls.runtime, [{ nodePath: '', mcpPath: '' }]);
  assert.equal(h.node().value, savedPaths.nodePath); assert.equal(h.mcp().value, savedPaths.mcpPath);
  assert.equal(h.token().value, 'unsaved-synthetic-token');
  assert.equal(h.publisher.settings.nodePath, ''); assert.equal(h.calls.saves.length, 0);
  assert.equal(h.calls.secretSaves, 0); assert.equal(h.calls.connections, 0);
});

test('saved paths and extension files are checked on every entry without saving or starting a connection', async () => {
  const h = await harness();
  const pending = deferred<RuntimeDetection>(); h.control.runtime = () => pending.promise;
  h.tab.display();
  assert.deepEqual(h.calls.runtime, [savedPaths]); assert.equal(h.calls.extension, 1);
  assert.deepEqual(h.badges(), ['检查中…', '检查中…', '检查中…']);
  assert.equal(h.node().value, savedPaths.nodePath); assert.equal(h.mcp().value, savedPaths.mcpPath);
  pending.resolve(available()); await settle();
  assert.deepEqual(h.badges(), ['✓ 已找到', '✓ 已找到', '✓ 已找到']);
  assert.match(h.summary(), /环境已就绪/);
  h.tab.hide(); assert.equal(h.timerCount(), 0);
  h.tick(); assert.equal(h.calls.runtime.length, 1);
  h.control.runtime = async paths => available(paths);
  h.tab.display(); await settle();
  assert.deepEqual(h.calls.runtime, [savedPaths, savedPaths]); assert.equal(h.calls.extension, 2);
  assert.equal(h.calls.saves.length, 0); assert.equal(h.calls.secretSaves, 0); assert.equal(h.calls.connections, 0);
});

test('editing or clearing fields during a saved-path check discards stale results without filling the cleared field', async () => {
  const h = await harness();
  const pending = deferred<RuntimeDetection>(); h.control.runtime = () => pending.promise;
  h.tab.display();
  h.node().enter('E:/Another/node'); h.mcp().enter(''); h.token().enter('edited-synthetic-token');
  pending.resolve(available()); await settle();
  h.tick(); await settle();
  assert.equal(h.node().value, 'E:/Another/node'); assert.equal(h.mcp().value, '');
  assert.equal(h.token().value, 'edited-synthetic-token');
  assert.deepEqual(h.badges().slice(0, 2), ['待检查', '待查找']);
  assert.equal(h.calls.runtime.length, 1); assert.equal(h.calls.saves.length, 0);
  assert.equal(h.publisher.settings.nodePath, savedPaths.nodePath);
});

test('a check finishing after the pane is reopened cannot replace the new pane results', async () => {
  const h = await harness();
  const oldCheck = deferred<RuntimeDetection>(); h.control.runtime = () => oldCheck.promise;
  h.tab.display(); h.tab.hide();
  h.publisher.settings = { ...h.publisher.settings, nodePath: 'E:/New/node' };
  h.control.runtime = async paths => available(paths);
  h.tab.display(); await settle();
  oldCheck.resolve({ nodeIssue: '旧目录已经删除', mcpIssue: '旧 MCP 不可用', issues: [] }); await settle();
  assert.equal(h.node().value, 'E:/New/node');
  assert.deepEqual(h.errors(), []); assert.deepEqual(h.badges(), ['✓ 已找到', '✓ 已找到', '✓ 已找到']);
  assert.match(h.summary(), /环境已就绪/); assert.equal(h.timerCount(), 1);
  assert.equal(h.calls.runtime.length, 2);
});

test('an unavailable saved directory shows the actual failure without claiming the old configuration works', async () => {
  const h = await harness();
  h.control.runtime = async () => ({ mcp: available().mcp, nodeIssue: '这个文件夹中未找到 Node.js，请重新选择。', issues: [] });
  h.tab.display(); await settle();
  assert.equal(h.node().value, savedPaths.nodePath);
  assert.equal(h.badges()[0], '目录不可用');
  assert.deepEqual(h.errors(), ['这个文件夹中未找到 Node.js，请重新选择。']);
  assert.match(h.summary(), /已保存的运行环境不可用/);
  assert.doesNotMatch(h.summary(), /继续有效|已就绪/);
  assert.equal(h.calls.saves.length, 0); assert.equal(h.calls.connections, 0);
});

test('entering while busy defers the saved-path check and performs it only once after becoming idle', async () => {
  const h = await harness({ busy: true });
  const pending = deferred<RuntimeDetection>(); h.control.runtime = () => pending.promise;
  h.tab.display(); h.tick(); h.tick();
  assert.equal(h.calls.runtime.length, 0); assert.equal(h.calls.extension, 0);
  assert.equal(h.node().disabled, true);
  h.publisher.busy = false;
  h.tick(); h.tick(); h.tick();
  assert.equal(h.calls.runtime.length, 1); assert.equal(h.calls.extension, 1);
  pending.resolve(available()); await settle(); h.tick(); h.tick();
  assert.equal(h.calls.runtime.length, 1); assert.match(h.summary(), /环境已就绪/);
  assert.equal(h.node().disabled, false); assert.equal(h.calls.connections, 0);
});

test('a runtime save completing after reopening synchronizes the new paths and checks them once', async () => {
  const h = await harness();
  h.tab.display(); await settle();
  h.node().enter('E:/Saved/node');
  const saving = deferred<void>(); h.control.persist = () => saving.promise;
  h.button('保存配置').click(); await settle();
  assert.equal(h.publisher.busy, true); assert.equal(h.calls.saves.length, 1);
  h.tab.hide(); h.tab.display();
  assert.equal(h.node().value, savedPaths.nodePath); assert.equal(h.calls.runtime.length, 2);
  saving.resolve(); await settle(); h.tick(); await settle(); h.tick();
  assert.equal(h.node().value, 'E:/Saved/node'); assert.equal(h.publisher.settings.nodePath, 'E:/Saved/node');
  assert.equal(h.calls.runtime.length, 3);
  assert.deepEqual(h.calls.runtime.at(-1), { nodePath: 'E:/Saved/node', mcpPath: savedPaths.mcpPath });
  assert.equal(h.calls.extension, 2); assert.equal(h.calls.saves.length, 1);
  assert.match(h.summary(), /环境已就绪/); assert.equal(h.calls.connections, 0);
});

test('reopened settings distinguish saved tokens, prior test outcomes and an in-progress connection', async () => {
  const cases: Array<{ result: TestResult; expected: string }> = [
    { result: null, expected: '密钥已保存，可测试连接' },
    { result: 'passed', expected: '✓ 上次测试通过' },
    { result: 'failed', expected: '上次测试未通过，请重试' },
    { result: 'testing', expected: '正在连接 Chrome…' },
  ];
  for (const { result, expected } of cases) {
    const h = await harness({ result, busy: result === 'testing' });
    h.tab.display(); await settle();
    assert.equal(h.testStatus(), expected);
    h.tab.hide(); h.tab.display(); await settle();
    assert.equal(h.testStatus(), expected); assert.equal(h.calls.connections, 0);
    if (result === 'testing') {
      h.control.result = 'passed'; h.publisher.busy = false;
      h.tick(); await settle(); h.tick();
      assert.equal(h.testStatus(), '✓ 上次测试通过');
    }
  }
});

test('a manual connection success remains current in its pane and becomes a previous result after reopening', async () => {
  const h = await harness();
  h.tab.display(); await settle();
  const connecting = deferred<void>(); h.control.connect = () => connecting.promise;
  h.button('测试连接').click();
  assert.equal(h.testStatus(), '正在连接 Chrome…'); assert.equal(h.calls.connections, 1);
  connecting.resolve(); await settle(); h.tick();
  assert.equal(h.testStatus(), '✓ 已连接到 Chrome');
  h.tab.hide(); h.tab.display(); await settle();
  assert.equal(h.testStatus(), '✓ 上次测试通过'); assert.equal(h.calls.connections, 1);
  const restarted = await harness();
  restarted.tab.display(); await settle();
  assert.equal(restarted.token().value, h.token().value);
  assert.equal(restarted.testStatus(), '密钥已保存，可测试连接');
  assert.equal(restarted.calls.connections, 0);
});
