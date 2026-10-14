import { Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type MarkdownXPublisher from './main';
import { cleanRuntimeDirectory, detectRuntime } from './browser/discovery';
import type { RuntimePaths } from './browser/discovery';
import { detectChromeExtension } from './browser/extension';
import { normalizeToken } from './browser/runtime';
import { chooseRuntimeFolder } from './ui/folder-picker';

export interface PublisherSettings {
  nodePath: string;
  mcpPath: string;
  secretName: string;
  autoPreview: boolean;
}
export const DEFAULT_SETTINGS: PublisherSettings = {
  nodePath: '', mcpPath: '', secretName: 'markdown-x-publisher-bridge', autoPreview: true
};
type PathKey = keyof RuntimePaths;
type PathCheck = { value: string; found: boolean; error?: string; version?: string };
type RuntimeField = { input: HTMLInputElement; status: HTMLElement; error: HTMLElement; picker: HTMLButtonElement };
const pathKeys: PathKey[] = ['nodePath', 'mcpPath'];
const pathNames = { nodePath: 'Node.js', mcpPath: 'Playwright MCP' };
const clean = (value: string): string => value.trim().replace(/^"(.*)"$/, '$1');

export class PublisherSettingTab extends PluginSettingTab {
  private generation = 0;
  private refreshTimer: number | undefined;
  constructor(app: App, private publisher: MarkdownXPublisher) {
    super(app, publisher);
    publisher.register(() => this.hide());
  }
  hide(): void {
    ++this.generation;
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }
  display(): void {
    this.hide();
    const generation = this.generation;
    const alive = () => generation === this.generation;
    const root = this.containerEl;
    root.empty(); root.addClass('mxp-settings');
    root.createEl('h2', { cls: 'mxp-settings-title', text: this.publisher.manifest.name });
    let savedPaths: RuntimePaths = {
      nodePath: cleanRuntimeDirectory(this.publisher.settings.nodePath, 'node'),
      mcpPath: cleanRuntimeDirectory(this.publisher.settings.mcpPath, 'mcp')
    };
    let savedToken = this.publisher.connectionSettings().token;
    let operation: 'detect' | 'save' | 'token' | 'test' | 'preview' | null = null;
    let revision = 0;
    let picking = false;
    let extensionFound: boolean | null = null;
    const checks: Partial<Record<PathKey, PathCheck>> = {};
    const fields = {} as Record<PathKey, RuntimeField>;
    const button = (parent: HTMLElement, text: string, primary = false): HTMLButtonElement =>
      parent.createEl('button', { text, cls: primary ? 'mod-cta' : '', attr: { type: 'button' } });
    const stateText = (element: HTMLElement, text: string, kind = '') => {
      element.setText(text);
      element.classList.remove('is-warning', 'is-success');
      if (kind) element.classList.add(`is-${kind}`);
    };
    const section = (title: string) => {
      const content = root.createDiv({ cls: 'mxp-settings-section' });
      const heading = content.createDiv({ cls: 'mxp-settings-heading' });
      heading.createEl('h3', { text: title });
      return { content, heading };
    };
    const environment = section('运行环境');
    button(environment.heading, '查看配置教程').onclick = () => this.publisher.showSetup();
    for (const key of pathKeys) {
      const program = environment.content.createDiv({ cls: 'mxp-runtime-program' });
      const label = program.createEl('label', { cls: 'mxp-runtime-label' });
      const row = label.createDiv({ cls: 'mxp-settings-row' });
      const name = row.createSpan({ cls: 'mxp-settings-name', text: pathNames[key] });
      name.createSpan({ cls: 'mxp-install-label', text: '安装文件夹' });
      const status = row.createSpan({ cls: 'mxp-runtime-badge', attr: { role: 'status' } });
      const field = label.createDiv({ cls: 'mxp-runtime-input' });
      const input = field.createEl('input', { type: 'text', cls: 'mxp-path', attr: {
        placeholder: '自动查找，也可输入安装文件夹路径', 'aria-label': `${pathNames[key]} 安装文件夹`, spellcheck: 'false'
      } });
      input.value = savedPaths[key];
      const picker = button(field, '');
      picker.addClass('mxp-folder-button');
      picker.setAttribute('aria-label', `选择 ${pathNames[key]} 安装文件夹`);
      picker.title = '选择安装文件夹'; setIcon(picker, 'folder-open');
      const error = program.createDiv({ cls: 'mxp-runtime-error', attr: { role: 'status' } });
      error.hidden = true;
      fields[key] = { input, status, error, picker };
    }
    environment.content.createEl('p', { cls: 'mxp-help', text: '检查已填写的路径，自动查找空白项。修改后请保存配置。' });
    const extension = environment.content.createDiv({ cls: 'mxp-settings-row mxp-extension-row' });
    extension.createSpan({ cls: 'mxp-settings-name', text: 'Playwright 浏览器扩展' });
    const extensionStatus = extension.createSpan({ cls: 'mxp-runtime-badge', attr: { role: 'status' } });
    const summary = environment.content.createDiv({ cls: 'mxp-runtime-summary', attr: { role: 'status' } });
    const actions = environment.content.createDiv({ cls: 'mxp-settings-row mxp-runtime-actions' });
    const savedStatus = actions.createSpan({ cls: 'mxp-settings-muted', attr: { role: 'status' } });
    const runtimeButtons = actions.createDiv({ cls: 'mxp-settings-buttons' });
    const detectButton = button(runtimeButtons, '自动检测');
    const saveRuntimeButton = button(runtimeButtons, '保存配置', true);

    const credentials = section('浏览器凭证').content;
    credentials.addClass('mxp-token-section');
    const tokenRow = credentials.createDiv({ cls: 'mxp-settings-row' });
    tokenRow.createSpan({ cls: 'mxp-settings-name', text: '连接密钥' });
    const tokenStatus = tokenRow.createSpan({ cls: 'mxp-settings-muted', text: savedToken ? '已保存' : '尚未填写', attr: { role: 'status' } });
    const tokenInput = credentials.createEl('input', { type: 'password', attr: {
      placeholder: '粘贴从 Playwright 扩展复制的密钥', 'aria-label': '连接密钥', autocomplete: 'off', spellcheck: 'false'
    } });
    tokenInput.value = savedToken;
    const saveTokenButton = button(credentials, '保存', true);
    saveTokenButton.addClass('mxp-token-save');
    const testRow = credentials.createDiv({ cls: 'mxp-test-row' });
    const testButton = button(testRow, '测试连接');
    const testStatus = testRow.createSpan({ cls: 'mxp-test-status', attr: { role: 'status' } });

    const logs = section('问题日志'); logs.content.addClass('mxp-settings-compact');
    button(logs.heading, '查看日志').onclick = () => this.publisher.showDiagnostics();
    const preview = section('预览');
    let updatePreviewDisabled = (_disabled: boolean): void => {};
    let updatePreviewValue = (_value: boolean): void => {};
    new Setting(preview.content).setName('自动刷新').setDesc('编辑文章后，预览内容会自动更新。')
      .addToggle(toggle => {
        updatePreviewDisabled = disabled => { toggle.setDisabled(disabled); };
        updatePreviewValue = value => { toggle.setValue(value); };
        toggle.setValue(this.publisher.settings.autoPreview).onChange(async value => {
          if (this.publisher.busy || operation) { toggle.setValue(this.publisher.settings.autoPreview); return; }
          operation = 'preview'; controls();
          try { await this.publisher.saveAutoPreview(value); }
          catch { if (alive()) toggle.setValue(this.publisher.settings.autoPreview); new Notice('自动刷新设置未能保存，请重试。'); }
          finally { operation = null; if (alive()) controls(); }
        });
      });
    root.createDiv({ cls: 'mxp-plugin-version', text: `当前版本 v${this.publisher.manifest.version}` });
    const paths = (): RuntimePaths => ({ nodePath: clean(fields.nodePath.input.value), mcpPath: clean(fields.mcpPath.input.value) });
    const configured = () => Boolean(savedPaths.nodePath && savedPaths.mcpPath);
    const dirty = () => !configured() || pathKeys.some(key => paths()[key] !== savedPaths[key]);
    const controls = () => {
      const locked = this.publisher.busy || (operation !== null && operation !== 'detect');
      for (const key of pathKeys) { fields[key].input.disabled = locked; fields[key].picker.disabled = locked || picking; }
      detectButton.disabled = !!operation || this.publisher.busy || picking;
      saveRuntimeButton.disabled = !!operation || this.publisher.busy || picking || !dirty() || !pathKeys.some(key => paths()[key]);
      saveTokenButton.disabled = !!operation || this.publisher.busy; tokenInput.disabled = locked;
      testButton.disabled = !!operation || this.publisher.busy || picking;
      updatePreviewDisabled(!!operation || this.publisher.busy);
      detectButton.setText(operation === 'detect' ? '检测中…' : '自动检测');
      saveRuntimeButton.setText(operation === 'save' ? '正在保存…' : '保存配置');
      saveTokenButton.setText(operation === 'token' ? '保存中…' : '保存');
      testButton.setText(operation === 'test' ? '连接中…' : '测试连接');
    };
    const render = () => {
      const current = paths();
      for (const key of pathKeys) {
        const check = checks[key]?.value === current[key] ? checks[key] : undefined;
        const changed = current[key] !== savedPaths[key] || !configured();
        stateText(fields[key].status, check?.found ? `✓ 已找到${changed ? '，待保存' : ''}` : check?.error ? (current[key] ? '目录不可用' : '未找到') : current[key] ? '待检查' : '待查找', check?.found ? 'success' : 'warning');
        fields[key].status.title = check?.version ?? '';
        fields[key].error.setText(check?.error ?? ''); fields[key].error.hidden = !check?.error;
      }
      stateText(extensionStatus, extensionFound === null ? '待检测' : extensionFound ? '✓ 已找到' : '未找到', extensionFound ? 'success' : 'warning');
      stateText(savedStatus, dirty() ? (configured() || current.nodePath || current.mcpPath ? '未保存' : '尚未配置') : '已保存', dirty() ? 'warning' : '');
      const failed = pathKeys.some(key => checks[key]?.value === current[key] && checks[key]?.error);
      const found = pathKeys.every(key => checks[key]?.value === current[key] && checks[key]?.found);
      if (this.publisher.busy && !operation) stateText(summary, '正在连接浏览器或保存草稿，完成后可修改配置。', 'warning');
      else if (failed) stateText(summary, `请修正标出的目录。${configured() ? '原有配置继续有效。' : ''}`, 'warning');
      else if (dirty()) stateText(summary, found ? 'Node.js 和 Playwright MCP 已找到，请保存配置。' : current.nodePath || current.mcpPath ? '路径已修改，保存配置后生效。' : '请点击“自动检测”，或选择安装文件夹。', 'warning');
      else if (found && extensionFound) stateText(summary, '✓ 三项已找到，环境已就绪', 'success');
      else stateText(summary, extensionFound === false ? '运行路径已保存；未找到 Playwright 扩展，请查看配置教程。' : '运行路径已保存，可以测试连接。', extensionFound === false ? 'warning' : '');
      controls();
    };
    const changed = (key: PathKey) => {
      ++revision; delete checks[key]; render();
      stateText(testStatus, dirty() ? '请先保存运行环境配置' : '尚未测试连接');
    };
    for (const key of pathKeys) {
      fields[key].input.oninput = () => changed(key);
      fields[key].picker.onclick = async event => {
        event.preventDefault();
        if (this.publisher.busy || picking || (operation && operation !== 'detect')) return;
        picking = true; controls();
        try {
          const chosen = await chooseRuntimeFolder(`选择 ${pathNames[key]} 安装文件夹`, paths()[key]);
          if (chosen !== null && alive() && !this.publisher.busy) { fields[key].input.value = chosen; changed(key); }
        } catch (error) { if (alive()) new Notice(error instanceof Error ? error.message : '无法打开文件夹选择窗口，请手动输入路径。'); }
        finally { picking = false; if (alive()) controls(); }
      };
    }
    const detect = async (save: boolean) => {
      if (operation || this.publisher.busy || picking) return;
      const snapshot = paths(), ticket = ++revision;
      operation = save ? 'save' : 'detect'; controls();
      for (const key of pathKeys) stateText(fields[key].status, '检查中…');
      try {
        const [found, extension] = await Promise.all([
          detectRuntime(snapshot), save ? Promise.resolve(null) : detectChromeExtension()
        ]);
        if (!alive() || ticket !== revision) return;
        if (extension) extensionFound = extension.found;
        const programs = { nodePath: found.node, mcpPath: found.mcp };
        const errors: Record<PathKey, string | undefined> = { nodePath: found.nodeIssue, mcpPath: found.mcpIssue };
        const complete = Boolean(found.node && found.mcp);
        const next: RuntimePaths = { ...snapshot };
        for (const key of pathKeys) {
          if (!next[key] && programs[key]) next[key] = programs[key]!.directory;
          if (!save && !snapshot[key]) fields[key].input.value = next[key];
          checks[key] = { value: paths()[key], found: Boolean(programs[key] && paths()[key]), error: errors[key], version: programs[key]?.version };
        }
        if (save && complete) {
          await this.publisher.saveRuntimePaths(next);
          if (!alive()) return;
          savedPaths = next;
          for (const key of pathKeys) {
            fields[key].input.value = next[key];
            checks[key] = { value: next[key], found: true, version: programs[key]?.version };
          }
          stateText(testStatus, '尚未测试连接');
        } else if (dirty()) stateText(testStatus, '请先保存运行环境配置');
        render();
        if (save && !complete) stateText(summary, `保存失败，请修正标出的目录。${configured() ? '原有配置继续有效。' : ''}`, 'warning');
      } catch (error) {
        if (alive() && ticket === revision) {
          render();
          stateText(summary, save ? `配置未能保存，请重试。${configured() ? '原有配置继续有效。' : ''}` : `检测未完成：${error instanceof Error ? error.message : '请重试。'}`, 'warning');
        }
      } finally {
        operation = null;
        if (alive()) { if (ticket !== revision) render(); else controls(); }
      }
    };
    detectButton.onclick = () => { void detect(false); };
    saveRuntimeButton.onclick = () => { void detect(true); };
    tokenInput.oninput = () => {
      stateText(tokenStatus, tokenInput.value === savedToken ? (savedToken ? '已保存' : '尚未填写') : '未保存', tokenInput.value === savedToken ? '' : 'warning');
      stateText(testStatus, dirty() ? '请先保存运行环境配置' : tokenInput.value === savedToken ? '尚未测试连接' : '请先保存密钥，再测试连接');
    };
    saveTokenButton.onclick = async () => {
      if (operation || this.publisher.busy) return;
      operation = 'token'; controls();
      try {
        await this.publisher.saveConnectionToken(tokenInput.value);
        if (!alive()) return;
        savedToken = this.publisher.connectionSettings().token; tokenInput.value = savedToken;
        stateText(tokenStatus, '已保存'); stateText(testStatus, dirty() ? '请先保存运行环境配置' : '尚未测试连接');
      } catch (error) { if (alive()) stateText(testStatus, error instanceof Error ? error.message : '密钥未能保存，请重试。', 'warning'); }
      finally { operation = null; if (alive()) controls(); }
    };
    testButton.onclick = async () => {
      if (operation || this.publisher.busy) return;
      if (dirty()) { stateText(testStatus, '请先保存运行环境配置', 'warning'); return; }
      if (!normalizeToken(savedToken) || tokenInput.value !== savedToken) { stateText(testStatus, '请先保存密钥，再测试连接', 'warning'); return; }
      operation = 'test'; controls(); stateText(testStatus, '正在连接 Chrome…');
      try { await this.publisher.testConnection(); if (alive()) stateText(testStatus, '✓ 已连接到 Chrome', 'success'); }
      catch (error) { if (alive()) stateText(testStatus, `连接失败：${error instanceof Error ? error.message : '请打开 Chrome，检查扩展和密钥后重试。'}`, 'warning'); }
      finally { operation = null; if (alive()) controls(); }
    };
    stateText(testStatus, dirty() ? '请先保存运行环境配置' : '尚未测试连接');
    render();
    let busyNoticeShown = this.publisher.busy;
    this.refreshTimer = window.setInterval(() => {
      if (!alive()) return;
      if (!this.publisher.busy && !operation) {
        // A save may finish after this pane was closed and reopened. Refresh its
        // saved baseline while preserving any new edits made in this pane.
        const latest: RuntimePaths = {
          nodePath: cleanRuntimeDirectory(this.publisher.settings.nodePath, 'node'),
          mcpPath: cleanRuntimeDirectory(this.publisher.settings.mcpPath, 'mcp')
        };
        const latestToken = this.publisher.connectionSettings().token;
        if (pathKeys.some(key => savedPaths[key] !== latest[key]) || savedToken !== latestToken) {
          for (const key of pathKeys) {
            if (paths()[key] === savedPaths[key]) fields[key].input.value = latest[key];
            if (savedPaths[key] !== latest[key]) delete checks[key];
          }
          if (tokenInput.value === savedToken) tokenInput.value = latestToken;
          savedPaths = latest; savedToken = latestToken;
          stateText(tokenStatus, tokenInput.value === savedToken ? (savedToken ? '已保存' : '尚未填写') : '未保存');
          stateText(testStatus, dirty() ? '请先保存运行环境配置' : '尚未测试连接');
          render();
        }
        updatePreviewValue(this.publisher.settings.autoPreview);
      }
      if (!operation && this.publisher.busy !== busyNoticeShown) {
        busyNoticeShown = this.publisher.busy; render();
      } else controls();
    }, 250);
  }
}
