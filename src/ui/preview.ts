import { ItemView, MarkdownView, Notice, setIcon } from 'obsidian';
import type { WorkspaceLeaf, TFile } from 'obsidian';
import type MarkdownXPublisher from '../main';
import { ArticleImageError, parseNote } from '../content/article';
import { renderArticle } from './render-article';
import { X_PUBLISHER_ICON } from './icons';

export const PREVIEW_TYPE = 'markdown-x-publisher-preview';

export class ArticlePreview extends ItemView {
  private article!: HTMLElement;
  private saveButton!: HTMLButtonElement;
  private file: TFile | null = null;
  private sourceView: MarkdownView | null = null;
  private timer: number | undefined;
  private generation = 0;
  private closed = true;

  constructor(leaf: WorkspaceLeaf, private publisher: MarkdownXPublisher) { super(leaf); }
  getViewType(): string { return PREVIEW_TYPE; }
  getDisplayText(): string { return 'X 文章预览'; }
  getIcon(): string { return X_PUBLISHER_ICON; }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.addClass('mxp-preview');
    const tools = this.contentEl.createDiv({ cls: 'mxp-toolbar' });
    const refresh = tools.createEl('button', { cls: 'mxp-icon-button', attr: { 'aria-label': '刷新预览' } });
    setIcon(refresh, 'rotate-cw');
    refresh.addEventListener('click', () => { void this.refresh(); });
    tools.createSpan({ cls: 'mxp-toolbar-label', text: 'X 文章' });
    const save = tools.createEl('button', { cls: 'mod-cta', text: '保存草稿' });
    this.saveButton = save;
    save.disabled = true;
    save.addEventListener('click', () => {
      if (!this.closed && !save.disabled && this.file) void this.publisher.openDraft(this.file, this.sourceView ?? undefined);
    });
    this.article = this.contentEl.createDiv({ cls: 'mxp-article markdown-rendered' });
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      const view = leaf?.view;
      if (!this.closed && view instanceof MarkdownView && view.file?.extension === 'md') void this.showFile(view.file, view);
    }));
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (this.closed || file?.extension !== 'md') return;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.file?.extension === 'md') void this.showFile(view.file, view);
      else if (this.app.workspace.getActiveFile()?.path === file.path) void this.showFile(file);
    }));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => {
      if (this.closed || info.file?.extension !== 'md') return;
      const active = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (info instanceof MarkdownView && active === info) {
        if (this.file?.path !== info.file.path) { void this.showFile(info.file, info); return; }
        this.sourceView = info;
      }
      if (!this.publisher.settings.autoPreview || info.file.path !== this.file?.path) return;
      if (info instanceof MarkdownView && this.sourceView && info !== this.sourceView) return;
      window.clearTimeout(this.timer);
      ++this.generation;
      this.timer = window.setTimeout(() => { void this.refresh(); }, 350);
    }));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (!this.closed && this.publisher.settings.autoPreview && file.path === this.file?.path) void this.refresh();
    }));
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? this.file ?? this.app.workspace.getActiveFile();
    if (file?.extension === 'md') await this.showFile(file, view ?? undefined);
    else await this.refresh();
  }

  async showFile(file: TFile, sourceView?: MarkdownView): Promise<void> {
    if (this.closed || file.extension !== 'md') return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
    const changed = file.path !== this.file?.path;
    this.file = file;
    if (sourceView?.file?.path === file.path) this.sourceView = sourceView;
    else if (changed) this.sourceView = null;
    if (changed) this.article.setText('正在加载文章…');
    await this.refresh();
  }

  private findSourceView(file: TFile): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path) return active;
    const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === file.path);
    if (this.sourceView && views.includes(this.sourceView)) return this.sourceView;
    return views[0] ?? null;
  }

  private async refresh(): Promise<void> {
    if (this.closed) return;
    const turn = ++this.generation;
    const file = this.file;
    this.saveButton.disabled = true;
    if (!file || file.extension !== 'md') {
      this.article.setText('打开一篇 Markdown 笔记，即可预览并保存到 X。'); return;
    }
    const path = file.path;
    const basename = file.basename;
    try {
      const view = this.findSourceView(file);
      if (view) this.sourceView = view;
      const markdown = view ? view.editor.getValue() : await this.app.vault.cachedRead(file);
      if (this.closed || turn !== this.generation || this.file?.path !== path) return;
      const note = parseNote(markdown, basename);
      renderArticle(this.app, this.article, note, path);
      this.saveButton.disabled = false;
      this.saveButton.title = `保存 ${path}`;
    } catch (error) {
      if (!this.closed && turn === this.generation) {
        this.article.empty();
        if (error instanceof ArticleImageError) {
          const panel = this.article.createDiv({ cls: 'mxp-preview-error', attr: { role: 'alert' } });
          panel.createEl('h2', { text: '暂时无法预览' });
          panel.createEl('p', { cls: 'mxp-error-location', text: error.location });
          panel.createEl('p', { text: error.reason });
          panel.createEl('p', { cls: 'mxp-error-label', text: '原文附近（标记行为问题所在段落）' });
          const excerpt = panel.createEl('pre', { cls: 'mxp-error-context' });
          for (const row of error.context) {
            const line = excerpt.createSpan({ cls: row.highlighted ? 'mxp-error-line is-highlighted' : 'mxp-error-line' });
            line.createSpan({ cls: 'mxp-error-line-number', text: `${row.highlighted ? '→' : ' '} ${row.line}` });
            line.createSpan({ cls: 'mxp-error-line-text', text: row.text || ' ' });
          }
          panel.createEl('p', { cls: 'mxp-error-label', text: '怎么修改' });
          panel.createEl('p', { text: error.suggestion });
        } else this.article.setText(`预览失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    ++this.generation;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export async function openPreview(publisher: MarkdownXPublisher): Promise<void> {
  const app = publisher.app;
  const leaf = app.workspace.getLeavesOfType(PREVIEW_TYPE)[0] ?? app.workspace.getRightLeaf(false);
  if (!leaf) { new Notice('无法打开预览面板。'); return; }
  // Keep the editor active until its unsaved buffer has been captured.
  await leaf.setViewState({ type: PREVIEW_TYPE, active: false });
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const file = view?.file ?? app.workspace.getActiveFile();
  if (file?.extension === 'md' && leaf.view instanceof ArticlePreview) await leaf.view.showFile(file, view ?? undefined);
  await app.workspace.revealLeaf(leaf);
}
