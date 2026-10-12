import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { resolveImage } from '../assets';
import type { MediaAsset } from '../model';
import { readLocalCover } from './cover-selection';
import type { CoverSelection } from './cover-selection';
import { CoverCropModal } from './cover-crop-modal';

type CoverTab = 'article' | 'local';

export class CoverPicker extends Modal {
  private alive = false;
  private request = 0;
  private objectUrl: string | undefined;
  private cropModal: CoverCropModal | undefined;

  constructor(app: App, private sources: string[], private notePath: string, private choose: (selection: CoverSelection) => void) { super(app); }

  onOpen(): void {
    this.alive = true;
    this.setTitle('选择封面图');
    this.modalEl.addClass('mxp-cover-modal');
    const root = this.contentEl;
    root.empty();
    let activeTab: CoverTab = 'article';
    let articleSource: string | undefined;
    let localAsset: MediaAsset | undefined;
    let reading = false;
    const tabs = root.createDiv({ cls: 'mxp-cover-tabs', attr: { role: 'tablist', 'aria-label': '封面来源' } });
    const articleTab = tabs.createEl('button', { text: '文章图片', attr: { type: 'button', role: 'tab' } });
    const localTab = tabs.createEl('button', { text: '本地图片', attr: { type: 'button', role: 'tab' } });
    const articlePanel = root.createDiv({ cls: 'mxp-cover-panel', attr: { role: 'tabpanel' } });
    const localPanel = root.createDiv({ cls: 'mxp-cover-panel', attr: { role: 'tabpanel' } });
    const grid = articlePanel.createDiv({ cls: 'mxp-cover-grid' });
    const articleStatus = articlePanel.createDiv({ cls: 'mxp-help', attr: { role: 'status' } });
    const fileLabel = localPanel.createEl('label', { cls: 'mxp-file-label', text: '从电脑选择图片' });
    const fileInput = fileLabel.createEl('input', { cls: 'mxp-file-input', attr: {
      type: 'file', accept: '.png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp',
    } });
    localPanel.createEl('p', { cls: 'mxp-help', text: '支持 PNG、JPEG、GIF、WebP，最大 20 MB。选择后暂存在本次操作中。' });
    const localPreview = localPanel.createDiv({ cls: 'mxp-cover-preview mxp-picker-preview', text: '选择图片后在这里预览' });
    const localStatus = localPanel.createDiv({ cls: 'mxp-help', attr: { role: 'status' } });
    const actions = root.createDiv({ cls: 'mxp-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    const confirm = actions.createEl('button', { text: '确认', cls: 'mod-cta', attr: { type: 'button' } });
    const updateConfirm = (): void => { confirm.disabled = activeTab === 'article' ? !articleSource : reading || !localAsset; };
    const switchTab = (tab: CoverTab): void => {
      activeTab = tab;
      for (const [button, selected] of [[articleTab, tab === 'article'], [localTab, tab === 'local']] as const) {
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
      articlePanel.hidden = tab !== 'article';
      localPanel.hidden = tab !== 'local';
      updateConfirm();
    };
    articleTab.addEventListener('click', () => switchTab('article'));
    localTab.addEventListener('click', () => switchTab('local'));
    tabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'article' : event.key === 'End' ? 'local' : activeTab === 'article' ? 'local' : 'article';
      switchTab(next);
      (next === 'article' ? articleTab : localTab).focus();
    });
    const sources = [...new Set(this.sources)];
    if (!sources.length) articleStatus.setText('文章中暂无图片，可以切换到“本地图片”选择。');
    for (const source of sources) {
      const item = grid.createEl('button', { cls: 'mxp-cover-item', attr: { type: 'button', 'aria-pressed': 'false', title: source } });
      item.disabled = true;
      const remote = /^https?:\/\//i.test(source);
      const file = remote ? null : resolveImage(this.app, source, this.notePath);
      const url = remote ? source : file ? this.app.vault.getResourcePath(file) : '';
      const caption = item.createSpan({ cls: 'mxp-cover-caption', text: source.split(/[\\/]/).pop() || source });
      if (!url) { caption.setText('找不到图片'); continue; }
      const image = item.createEl('img', { attr: { alt: source } });
      item.insertBefore(image, caption);
      image.addEventListener('load', () => { if (this.alive) item.disabled = false; });
      image.addEventListener('error', () => {
        if (!this.alive) return;
        item.disabled = true;
        caption.setText('图片无法加载');
        if (articleSource === source) { articleSource = undefined; item.setAttribute('aria-pressed', 'false'); updateConfirm(); }
      });
      image.src = url;
      item.addEventListener('click', () => {
        if (item.disabled || !this.alive) return;
        articleSource = source;
        grid.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === item)));
        articleStatus.setText(`已选择：${source}`);
        updateConfirm();
      });
    }
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const request = ++this.request;
      this.releaseObjectUrl();
      localAsset = undefined;
      reading = true;
      localPreview.setText('正在读取图片…');
      localStatus.setText(file.name);
      updateConfirm();
      void (async () => {
        try {
          const asset = await readLocalCover(file);
          if (!this.alive || request !== this.request) return;
          const objectUrl = URL.createObjectURL(file);
          this.objectUrl = objectUrl;
          const image = localPreview.ownerDocument.createElement('img');
          image.alt = file.name;
          image.src = objectUrl;
          try { await image.decode(); }
          catch { throw new Error('图片无法解码，文件可能已损坏，请重新选择。'); }
          if (!this.alive || request !== this.request) return;
          localAsset = asset;
          localPreview.replaceChildren(image);
          localStatus.setText(`${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`);
        } catch (error) {
          if (!this.alive || request !== this.request) return;
          this.releaseObjectUrl();
          localPreview.setText('尚未选择可用图片');
          localStatus.setText(error instanceof Error ? error.message : '读取图片失败，请重试。');
          fileInput.value = '';
        } finally {
          if (this.alive && request === this.request) { reading = false; updateConfirm(); }
        }
      })();
    });
    cancel.addEventListener('click', () => this.close());
    confirm.addEventListener('click', () => {
      if (confirm.disabled || !this.alive) return;
      const selection = activeTab === 'article' && articleSource ? { source: articleSource }
        : activeTab === 'local' && localAsset && !reading ? { source: localAsset.source, asset: localAsset } : undefined;
      if (!selection) return;
      if (this.cropModal) return;
      this.cropModal = new CoverCropModal(this.app, selection, this.notePath, cropped => {
        if (!this.alive) return;
        this.cropModal = undefined;
        this.choose(cropped);
        this.close();
      }, () => { this.cropModal = undefined; });
      this.cropModal.open();
    });
    switchTab('article');
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }

  onClose(): void {
    this.alive = false;
    ++this.request;
    this.cropModal?.close();
    this.cropModal = undefined;
    this.releaseObjectUrl();
    this.contentEl.empty();
  }
}
