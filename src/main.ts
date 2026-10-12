import { addIcon, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, PublisherSettingTab } from './settings';
import type { PublisherSettings } from './settings';
import { ArticlePreview, PREVIEW_TYPE, openPreview } from './ui/preview';
import { DraftModal } from './ui/draft-modal';
import { SetupModal } from './ui/setup';
import { parseNote } from './content/article';
import { loadImage } from './assets';
import { connectBrowser } from './browser/runtime';
import { saveDraft } from './browser/x-draft';
import type { DraftSaveSession } from './browser/x-draft';
import { DiagnosticLog } from './diagnostics';
import { DiagnosticModal } from './ui/diagnostic-modal';
import { X_PUBLISHER_ICON, X_PUBLISHER_ICON_SVG } from './ui/icons';
import type { BrowserBridge, ConnectionSettings, DraftResult, MediaAsset, ParsedNote, Progress } from './model';

export default class MarkdownXPublisher extends Plugin {
  settings: PublisherSettings = { ...DEFAULT_SETTINGS };
  busy = false;
  private bridge: BrowserBridge | null = null;
  private bridgeSettings: ConnectionSettings | null = null;
  private unloaded = false;
  private diagnosticLog: DiagnosticLog | undefined;

  get diagnostics(): DiagnosticLog {
    return this.diagnosticLog ??= new DiagnosticLog(this.app, this.manifest?.dir ?? `${this.app.vault.configDir ?? '.obsidian'}/plugins/markdown-x-publisher`);
  }

  async onload(): Promise<void> {
    await this.diagnostics.init();
    if (this.unloaded) return;
    const saved = await this.loadData() as Partial<PublisherSettings> | null;
    if (this.unloaded) return;
    this.settings = {
      nodePath: typeof saved?.nodePath === 'string' ? saved.nodePath : '',
      mcpPath: typeof saved?.mcpPath === 'string' ? saved.mcpPath : '',
      secretName: typeof saved?.secretName === 'string' ? saved.secretName : DEFAULT_SETTINGS.secretName,
      autoPreview: typeof saved?.autoPreview === 'boolean' ? saved.autoPreview : true
    };
    addIcon(X_PUBLISHER_ICON, X_PUBLISHER_ICON_SVG);
    this.addSettingTab(new PublisherSettingTab(this.app, this));
    this.registerView(PREVIEW_TYPE, leaf => new ArticlePreview(leaf, this));
    this.addRibbonIcon(X_PUBLISHER_ICON, '预览 X 文章', () => { void openPreview(this); });
    this.addCommand({ id: 'open-preview', name: '预览 X 文章', callback: () => openPreview(this) });
    this.addCommand({ id: 'save-draft', name: '保存到 X 草稿', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (file?.extension !== 'md') return false;
      if (!checking) void this.openDraft(file);
      return true;
    } });
    this.addCommand({ id: 'connection-guide', name: '浏览器连接说明', callback: () => this.showSetup() });
    this.addCommand({ id: 'diagnostics', name: '查看问题日志', callback: () => this.showDiagnostics() });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') {
        menu.addItem(item => item.setTitle('保存到 X 草稿').setIcon(X_PUBLISHER_ICON).onClick(() => { void this.openDraft(file); }));
      }
    }));
  }

  connectionSettings(): ConnectionSettings {
    return { nodePath: this.settings.nodePath, mcpPath: this.settings.mcpPath,
      token: this.settings.secretName ? this.app.secretStorage.getSecret(this.settings.secretName) ?? '' : '' };
  }
  async saveSettings(): Promise<void> {
    if (this.bridgeSettings && !this.sameConnection(this.bridgeSettings, this.connectionSettings())) await this.releaseBridge();
    await this.saveData(this.settings);
  }
  showSetup(): void { new SetupModal(this.app).open(); }
  showDiagnostics(): void { new DiagnosticModal(this.app, this.diagnostics).open(); }

  private sameConnection(left: ConnectionSettings, right: ConnectionSettings): boolean {
    return left.nodePath === right.nodePath && left.mcpPath === right.mcpPath && left.token === right.token;
  }

  private assertConnectionCurrent(settings: ConnectionSettings): void {
    if (this.unloaded) throw new Error('插件已停用，连接或保存已取消。');
    if (!this.sameConnection(settings, this.connectionSettings())) throw new Error('浏览器连接设置已更改，请重新操作。');
  }

  private async releaseBridge(): Promise<void> {
    const bridge = this.bridge;
    this.bridge = null;
    this.bridgeSettings = null;
    // Closing only releases MCP. A cleanup error must not replace a saved draft or the original failure.
    try { await bridge?.close(); } catch { /* Best-effort cleanup. */ }
  }

  private async getBridge(settings: ConnectionSettings): Promise<BrowserBridge> {
    this.assertConnectionCurrent(settings);
    if (!settings.token) throw new Error('请先在插件设置中配置浏览器连接凭据，并测试连接。');
    if (this.bridgeSettings && !this.sameConnection(this.bridgeSettings, settings)) await this.releaseBridge();
    this.assertConnectionCurrent(settings);
    if (this.bridge) {
      const bridge = this.bridge;
      try {
        await bridge.call('browser_tabs', { action: 'list' });
        this.assertConnectionCurrent(settings);
        if (this.bridge === bridge) return bridge;
      } catch {
        // Only reconnect before an operation starts; never replay an article upload.
        await this.releaseBridge();
        this.assertConnectionCurrent(settings);
      }
    }
    const bridge = await connectBrowser(settings, (event, details) => this.diagnostics.record(event, details));
    let adopted = false;
    try {
      this.assertConnectionCurrent(settings);
      this.bridge = bridge;
      this.bridgeSettings = { ...settings };
      adopted = true;
      // This also establishes the real extension connection for the connection-test button.
      await bridge.call('browser_tabs', { action: 'list' });
      this.assertConnectionCurrent(settings);
      if (this.bridge !== bridge) throw new Error('浏览器连接已释放，请重新操作。');
      return bridge;
    } catch (error) {
      if (this.bridge === bridge) await this.releaseBridge();
      else if (!adopted) { try { await bridge.close(); } catch { /* Preserve the original failure. */ } }
      throw error;
    }
  }

  async testConnection(): Promise<string> {
    if (this.unloaded) throw new Error('插件已停用，连接已取消。');
    if (this.busy) throw new Error('正在连接浏览器或保存草稿，请稍候。');
    this.busy = true;
    this.diagnostics.start('connection');
    const started = Date.now();
    try {
      await this.getBridge(this.connectionSettings());
      this.diagnostics.record('operation.completed', { operation: 'connection', elapsedMs: Date.now() - started });
      return '已连接日常 Chrome，连接凭据有效。连接将保留供后续保存草稿使用。';
    } catch (error) { this.diagnostics.fail('connection', error); await this.releaseBridge(); throw error; }
    finally { this.busy = false; await this.diagnostics.flush(); }
  }

  async openDraft(file: TFile, sourceView?: MarkdownView): Promise<void> {
    if (this.busy) { new Notice('正在保存草稿，请稍候。'); return; }
    try {
      const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
        .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === file.path);
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const view = sourceView && views.includes(sourceView) ? sourceView
        : activeView && views.includes(activeView) ? activeView : views[0];
      const markdown = view ? view.editor.getValue() : await this.app.vault.cachedRead(file);
      new DraftModal(this, file, parseNote(markdown, file.basename)).open();
    } catch (error) { new Notice(`无法读取文章：${error instanceof Error ? error.message : String(error)}`, 6000); }
  }

  async saveDraft(file: TFile, note: ParsedNote, progress: Progress, coverAsset?: MediaAsset, session: DraftSaveSession = {}): Promise<DraftResult> {
    if (this.unloaded) throw new Error('插件已停用，保存已取消。');
    if (this.busy) throw new Error('已有文章正在保存。');
    this.busy = true;
    this.diagnostics.start('save');
    const started = Date.now();
    let stage = 'prepare';
    const diagnostic = (event: string, details?: Record<string, string | number | boolean | null>): void => {
      if (details?.stage && typeof details.stage === 'string') stage = details.stage;
      this.diagnostics.record(event, details);
    };
    try {
      const connection = this.connectionSettings();
      if (!connection.token) throw new Error('请先在插件设置中配置浏览器连接凭据，并测试连接。');
      progress('正在准备正文图片…');
      const sources = [...new Set(note.blocks.filter(block => block.type === 'image').map(block => block.source))];
      const assets = [];
      for (const [index, source] of sources.entries()) {
        const imageStarted = Date.now();
        const asset = await loadImage(this.app, source, file.path);
        assets.push(asset);
        diagnostic('image.prepared', { index: index + 1, total: sources.length, mime: asset.mime, bytes: Math.floor(asset.base64.length * 3 / 4), durationMs: Date.now() - imageStarted });
      }
      const cover = coverAsset ?? (note.cover ? assets.find(asset => asset.source === note.cover) ?? await loadImage(this.app, note.cover, file.path) : undefined);
      progress('正在连接日常 Chrome…');
      stage = 'connection';
      const bridge = await this.getBridge(connection);
      stage = 'draft';
      const result = await saveDraft(bridge, { title: note.title, blocks: note.blocks, images: assets, cover }, progress, diagnostic, session);
      diagnostic('operation.completed', { operation: 'save', elapsedMs: Date.now() - started });
      return result;
    } catch (error) {
      this.diagnostics.fail(stage, error);
      if (!session.resumable) await this.releaseBridge();
      throw error;
    } finally {
      this.busy = false;
      await this.diagnostics.flush();
    }
  }

  onunload(): void { this.unloaded = true; void this.releaseBridge(); void this.diagnosticLog?.flush(); }
}
