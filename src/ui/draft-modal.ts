import { Modal, Notice } from 'obsidian';
import type { TFile } from 'obsidian';
import type MarkdownXPublisher from '../main';
import type { ParsedNote } from '../model';
import { resolveImage } from '../assets';
import { CoverPicker } from './cover-picker';
import { CoverCropModal } from './cover-crop-modal';
import type { CoverSelection } from './cover-selection';
import type { DraftSaveSession } from '../browser/x-draft';

export class DraftModal extends Modal {
  private saving = false;
  private saved = false;
  private closed = false;
  private closeTimer: number | undefined;
  private picker: CoverPicker | undefined;
  private cropModal: CoverCropModal | undefined;
  private session: DraftSaveSession = {};

  constructor(private publisher: MarkdownXPublisher, private file: TFile, private note: ParsedNote) { super(publisher.app); }

  onOpen(): void {
    this.closed = false;
    this.saved = false;
    window.clearTimeout(this.closeTimer);
    this.setTitle('保存到 X 草稿');
    this.modalEl.addClass('mxp-draft-modal');
    const root = this.contentEl;
    root.empty();
    root.createEl('p', { cls: 'mxp-help mxp-note-path', text: this.file.path });
    const titleField = root.createDiv({ cls: 'mxp-draft-field' });
    const titleLabel = titleField.createEl('label', { cls: 'mxp-field-label', text: '标题' });
    const titleInput = titleLabel.createEl('input', { cls: 'mxp-title-input', attr: { type: 'text' } });
    titleInput.value = this.note.title;
    const coverField = root.createDiv({ cls: 'mxp-draft-field' });
    coverField.createDiv({ cls: 'mxp-field-label', text: '封面' });
    const preview = coverField.createDiv({ cls: 'mxp-cover-preview mxp-draft-cover' });
    const coverActions = coverField.createDiv({ cls: 'mxp-cover-actions' });
    const choose = coverActions.createEl('button', { text: '选择封面', attr: { type: 'button' } });
    const crop = coverActions.createEl('button', { text: '裁剪封面', attr: { type: 'button' } });
    const clear = coverActions.createEl('button', { text: '清除封面', cls: 'mxp-clear-cover', attr: { type: 'button' } });
    coverField.createEl('p', { cls: 'mxp-help', text: '可以不设置封面。选中的图片会在保存草稿时上传。' });
    let cover: CoverSelection = { source: '' };
    let previewVersion = 0;
    const drawCover = (): void => {
      const version = ++previewVersion;
      preview.empty();
      clear.hidden = !cover.source;
      crop.hidden = !cover.source;
      crop.setText(cover.crop ? '重新裁剪' : '裁剪封面');
      preview.classList.toggle('mxp-cropped-cover', Boolean(cover.crop));
      if (!cover.source) { preview.setText('未选择封面'); return; }
      const local = cover.asset || /^https?:\/\//i.test(cover.source) ? null : resolveImage(this.app, cover.source, this.file.path);
      const url = cover.asset ? `data:${cover.asset.mime};base64,${cover.asset.base64}`
        : /^https?:\/\//i.test(cover.source) ? cover.source : local ? this.app.vault.getResourcePath(local) : '';
      if (!url) { preview.setText('找不到封面图片，请重新选择或清除。'); return; }
      const image = preview.createEl('img', { attr: { alt: cover.asset?.name ?? '封面预览' } });
      image.addEventListener('error', () => {
        if (!this.closed && version === previewVersion) preview.setText('封面预览无法加载，请重新选择或清除。');
      });
      image.src = url;
    };
    const images = [...new Set(this.note.blocks.filter(block => block.type === 'image').map(block => block.source))];
    const editCover = (): void => {
      if (this.saving || this.saved || this.closed || this.session.resumable || !cover.source || this.cropModal) return;
      this.cropModal = new CoverCropModal(this.app, cover, this.file.path, selection => {
        if (this.closed || this.saving || this.saved) return;
        cover = selection;
        drawCover();
      }, () => { this.cropModal = undefined; });
      this.cropModal.open();
    };
    crop.addEventListener('click', editCover);
    choose.addEventListener('click', () => {
      if (this.saving || this.saved || this.closed) return;
      this.picker?.close();
      this.picker = new CoverPicker(this.app, images, this.file.path, selection => {
        if (this.closed || this.saving || this.saved) return;
        cover = selection;
        drawCover();
      });
      this.picker.open();
    });
    clear.addEventListener('click', () => {
      if (this.saving || this.saved) return;
      cover = { source: '' };
      drawCover();
    });
    drawCover();
    const textLength = this.note.blocks.reduce((total, block) => total + (block.type === 'text' ? block.text.length : block.type === 'markdown' ? block.markdown.length : 0), 0);
    root.createEl('p', { cls: 'mxp-help', text: `${textLength} 字符 · ${images.length} 张正文图片 · 保存后可在 X 中继续编辑` });
    const status = root.createDiv({ cls: 'mxp-save-status', attr: { role: 'status' } });
    const actions = root.createDiv({ cls: 'mxp-modal-actions' });
    const logs = actions.createEl('button', { text: '查看日志', attr: { type: 'button' } });
    logs.addEventListener('click', () => this.publisher.showDiagnostics());
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    const save = actions.createEl('button', { text: '保存到草稿', cls: 'mod-cta', attr: { type: 'button' } });
    const disableControls = (disabled: boolean): void => {
      root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(element => { element.disabled = disabled; });
      logs.disabled = false;
    };
    cancel.addEventListener('click', () => this.close());
    save.addEventListener('click', () => {
      if (this.saving || this.saved || this.closed) return;
      if (this.publisher.busy) { new Notice('已有文章正在保存，请稍候。'); return; }
      const title = titleInput.value.trim();
      if (!title) { new Notice('请填写文章标题。'); titleInput.focus(); return; }
      if (cover.source && !cover.crop) {
        status.setText('请先裁剪封面，应用后再保存到草稿。');
        editCover();
        return;
      }
      if (!this.session.resumable) this.session = {};
      this.saving = true;
      disableControls(true);
      save.setText('保存中…');
      void (async () => {
        try {
          const result = await this.publisher.saveDraft(this.file, { ...this.note, title }, message => {
            if (!this.closed) status.setText(message);
          }, cover.asset, this.session);
          this.saved = true;
          new Notice('X 草稿已保存并核对。', 3000);
          if (this.closed) return;
          status.empty();
          status.createEl('a', { text: '草稿已保存并核对，打开 X 查看', href: result.url, attr: { target: '_blank', rel: 'noopener noreferrer' } });
          save.setText('已保存');
          cancel.setText('关闭');
          cancel.disabled = false;
          this.closeTimer = window.setTimeout(() => { if (this.saved && !this.closed) this.close(); }, 1500);
        } catch (error) {
          const message = `保存未完成：${error instanceof Error ? error.message : String(error)}`;
          if (this.closed) new Notice(message, 6000);
          else {
            status.setText(message);
            const recovery = message.match(/https:\/\/x\.com\/compose\/articles\/edit\/\d+/)?.[0];
            if (recovery) {
              status.createEl('p').createEl('a', { text: '打开已创建的草稿检查', href: recovery, attr: { target: '_blank', rel: 'noopener noreferrer' } });
              status.createEl('p', { text: this.session.resumable
                ? '已保留本次进度。保持此窗口和 X 草稿页打开，点击继续会核对已上传图片，再接着完成当前草稿。'
                : '本次进度无法安全续传，请先检查已有草稿。' });
            }
            save.setText(this.session.resumable ? '继续当前草稿' : recovery ? '另存新草稿' : '重新保存');
          }
        } finally {
          this.saving = false;
          if (!this.saved && !this.closed) {
            disableControls(false);
            if (this.session.resumable) { titleInput.disabled = true; choose.disabled = true; crop.disabled = true; clear.disabled = true; }
          }
        }
      })();
    });
  }

  onClose(): void {
    this.closed = true;
    window.clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.picker?.close();
    this.picker = undefined;
    this.cropModal?.close();
    this.cropModal = undefined;
    this.contentEl.empty();
  }

  close(): void {
    if (this.saving) { new Notice('正在保存草稿，请等待完成后再关闭。', 3000); return; }
    super.close();
  }
}
