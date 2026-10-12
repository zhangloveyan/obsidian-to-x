import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { DiagnosticLog } from '../diagnostics';

export class DiagnosticModal extends Modal {
  constructor(app: App, private log: DiagnosticLog) { super(app); }

  onOpen(): void {
    this.setTitle('问题日志');
    const root = this.contentEl;
    root.empty();
    root.createEl('p', { cls: 'mxp-help', text: '仅记录最近一次操作的阶段、耗时和状态，不记录文章正文、图片或浏览器连接凭据。日志只保存在本地。' });
    const output = root.createEl('textarea', { cls: 'mxp-diagnostic-log', attr: { readonly: '', rows: '18', cols: '68', 'aria-label': '问题日志', spellcheck: 'false' } });
    const refresh = (): void => { output.value = this.log.text() || '暂时没有日志。完成一次连接测试或保存操作后，可在这里查看。'; };
    refresh();
    new Setting(root)
      .addButton(button => button.setButtonText('复制日志').onClick(async () => {
        const text = this.log.text();
        if (!text) { new Notice('暂时没有可复制的日志。'); return; }
        try { await navigator.clipboard.writeText(text); new Notice('日志已复制。', 2500); }
        catch { new Notice('复制失败，可在日志框中全选后手动复制。'); }
      }))
      .addButton(button => button.setButtonText('刷新').onClick(refresh))
      .addButton(button => button.setButtonText('关闭').onClick(() => this.close()));
  }

  onClose(): void { this.contentEl.empty(); }
}
